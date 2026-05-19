// list.go — Phase 1: discover every cached tile under `watercolor/`
// in the upstream bucket and emit a manifest sorted by Hilbert
// tile-id.
//
// The upstream S3 bucket forbids ListObjectsV2 (only GetObject is
// allowed under the requester-pays grant), so we can't enumerate the
// way you would normally enumerate an S3 prefix. Instead we do a
// **breadth-first frontier crawl**: start from (z=0, x=0, y=0); for
// each tile that returns 200, queue its 4 children at z+1; stop when
// every survivor at the current zoom has been processed or we hit
// maxZoom.
//
// This catches every tile whose chain of ancestors all exist — which
// is how Stamen's cache was populated, since the upstream MapLibre /
// Leaflet clients would have requested parents before zooming in.
// Tiles whose ancestors are absent (a few percent of edge cases) are
// missed; that's the documented trade-off for not having a manifest.

package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/protomaps/go-pmtiles/pmtiles"
)

const maxZoom = 18

type manifestEntry struct {
	TileID uint64
	Key    string
	Size   int64
	ETag   string
}

type tileCoord struct {
	z uint8
	x uint32
	y uint32
}

func runList(ctx context.Context, args []string) error {
	var (
		bucket, prefix, outPath string
		concurrency, maxZ       int
	)
	parseFlags("list", args, func(fs *flag.FlagSet) {
		fs.StringVar(&bucket, "bucket", "long-term.cache.maps.stamen.com", "source S3 bucket")
		fs.StringVar(&prefix, "prefix", "watercolor/", "key prefix (must end with /)")
		fs.StringVar(&outPath, "out", "manifest.tsv", "output manifest path")
		fs.IntVar(&concurrency, "concurrency", 64, "parallel HEAD requests")
		fs.IntVar(&maxZ, "max-zoom", maxZoom, "stop the frontier crawl after this zoom (inclusive)")
	})
	if !strings.HasSuffix(prefix, "/") {
		return fmt.Errorf("--prefix must end with /, got %q", prefix)
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return fmt.Errorf("aws config: %w", err)
	}
	// AdaptiveMode dynamically backs off when the upstream throttles
	// (Stamen's bucket starts returning 503 once concurrent HEAD count
	// gets meaningfully past ~50). Pair it with our own retry loop in
	// headTile() to survive the case where the SDK still gives up.
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.Retryer = retry.NewAdaptiveMode(func(am *retry.AdaptiveModeOptions) {
			am.StandardOptions = append(am.StandardOptions, func(so *retry.StandardOptions) {
				so.MaxAttempts = 10
			})
		})
	})

	allEntries := make([]manifestEntry, 0, 64*1024*1024)
	current := []tileCoord{{z: 0, x: 0, y: 0}}

	for z := 0; z <= maxZ && len(current) > 0; z++ {
		start := time.Now()
		survivors, entries := probeBatch(ctx, client, bucket, prefix, current, concurrency)
		log.Printf("z=%d: %d survived out of %d candidates in %s",
			z, len(survivors), len(current), time.Since(start).Truncate(time.Second))
		allEntries = append(allEntries, entries...)
		if z == maxZ {
			break
		}
		current = childrenOf(survivors)
	}

	log.Printf("sorting %d entries by Hilbert tile-id…", len(allEntries))
	sort.Slice(allEntries, func(i, j int) bool { return allEntries[i].TileID < allEntries[j].TileID })

	return writeManifest(outPath, allEntries)
}

// probeBatch HEADs every coord in `candidates` in parallel and returns
// the subset that exists. `survivors` preserves coord identity (for
// child enumeration); `entries` carries the manifest data.
func probeBatch(
	ctx context.Context,
	client *s3.Client,
	bucket, prefix string,
	candidates []tileCoord,
	concurrency int,
) (survivors []tileCoord, entries []manifestEntry) {
	type result struct {
		coord tileCoord
		entry manifestEntry
		ok    bool
	}

	work := make(chan tileCoord, concurrency*2)
	results := make(chan result, concurrency*2)
	var wg sync.WaitGroup

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range work {
				key := keyFor(prefix, c)
				size, etag, ok, err := headTile(ctx, client, bucket, key)
				if err != nil && !isMissing(err) {
					// Non-existence errors are expected; anything else
					// (auth, throttling, network) we surface so the
					// operator notices. We don't bail the whole batch
					// since a single transient HEAD failure shouldn't
					// kill an hours-long crawl.
					log.Printf("HEAD %s: %v", key, err)
				}
				r := result{coord: c, ok: ok}
				if ok {
					r.entry = manifestEntry{
						TileID: pmtiles.ZxyToID(c.z, c.x, c.y),
						Key:    key,
						Size:   size,
						ETag:   etag,
					}
				}
				results <- r
			}
		}()
	}

	go func() {
		defer close(work)
		for _, c := range candidates {
			select {
			case <-ctx.Done():
				return
			case work <- c:
			}
		}
	}()
	go func() {
		wg.Wait()
		close(results)
	}()

	var processed atomic.Uint64
	logEvery := time.NewTicker(15 * time.Second)
	defer logEvery.Stop()

	for {
		select {
		case <-logEvery.C:
			log.Printf("  …processed %d/%d", processed.Load(), len(candidates))
		case r, ok := <-results:
			if !ok {
				return survivors, entries
			}
			processed.Add(1)
			if r.ok {
				survivors = append(survivors, r.coord)
				entries = append(entries, r.entry)
			}
		}
	}
}

func headTile(ctx context.Context, client *s3.Client, bucket, key string) (int64, string, bool, error) {
	// Wrap with our own retry loop on top of the SDK's. Stamen's bucket
	// throttles aggressively under high concurrency and the SDK's default
	// adaptive limiter can exhaust its retry quota during long bursts;
	// when that happens we get the raw 503 back here. Treating those as
	// "missing" would silently drop real tiles, so we retry explicitly
	// with our own exponential backoff before giving up.
	const maxAttempts = 6
	backoff := 500 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		out, err := client.HeadObject(ctx, &s3.HeadObjectInput{
			Bucket:       aws.String(bucket),
			Key:          aws.String(key),
			RequestPayer: types.RequestPayerRequester,
		})
		if err == nil {
			etag := strings.Trim(aws.ToString(out.ETag), "\"")
			return aws.ToInt64(out.ContentLength), etag, true, nil
		}
		if isMissing(err) {
			return 0, "", false, err
		}
		if !isTransient(err) {
			return 0, "", false, err
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return 0, "", false, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
	return 0, "", false, fmt.Errorf("after %d attempts: %w", maxAttempts, lastErr)
}

// isTransient identifies retryable upstream conditions: rate-limiting
// (429), generic 5xx, and the SDK's "retry quota exceeded" message
// that surfaces when the adaptive limiter gives up.
func isTransient(err error) bool {
	var apiErr *smithyhttp.ResponseError
	if errors.As(err, &apiErr) {
		switch apiErr.HTTPStatusCode() {
		case 429, 500, 502, 503, 504:
			return true
		}
	}
	s := err.Error()
	if strings.Contains(s, "StatusCode: 429") ||
		strings.Contains(s, "StatusCode: 500") ||
		strings.Contains(s, "StatusCode: 502") ||
		strings.Contains(s, "StatusCode: 503") ||
		strings.Contains(s, "StatusCode: 504") ||
		strings.Contains(s, "Service Unavailable") ||
		strings.Contains(s, "retry quota exceeded") ||
		strings.Contains(s, "Throttling") {
		return true
	}
	return false
}

func childrenOf(parents []tileCoord) []tileCoord {
	out := make([]tileCoord, 0, len(parents)*4)
	for _, p := range parents {
		nz := p.z + 1
		out = append(out,
			tileCoord{z: nz, x: p.x * 2, y: p.y * 2},
			tileCoord{z: nz, x: p.x*2 + 1, y: p.y * 2},
			tileCoord{z: nz, x: p.x * 2, y: p.y*2 + 1},
			tileCoord{z: nz, x: p.x*2 + 1, y: p.y*2 + 1},
		)
	}
	return out
}

func keyFor(prefix string, c tileCoord) string {
	return fmt.Sprintf("%s%d/%d/%d.jpg", prefix, c.z, c.x, c.y)
}

// isMissing identifies "tile not present" errors, which during a
// frontier crawl is the normal-case outcome for ~3 of 4 children.
// Stamen's bucket returns 403 (not 404) for absent keys, so we have to
// accept both.
func isMissing(err error) bool {
	var nsk *types.NoSuchKey
	if errors.As(err, &nsk) {
		return true
	}
	var apiErr *smithyhttp.ResponseError
	if errors.As(err, &apiErr) {
		switch apiErr.HTTPStatusCode() {
		case 403, 404:
			return true
		}
	}
	s := err.Error()
	return strings.Contains(s, "StatusCode: 403") || strings.Contains(s, "StatusCode: 404")
}

func writeManifest(path string, entries []manifestEntry) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 4<<20)
	defer w.Flush()
	for _, e := range entries {
		if _, err := fmt.Fprintf(w, "%d\t%s\t%d\t%s\n", e.TileID, e.Key, e.Size, e.ETag); err != nil {
			return err
		}
	}
	return nil
}
