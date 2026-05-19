// list.go — Phase 1: enumerate every JPEG under `watercolor/` in the
// upstream bucket and emit a manifest sorted by Hilbert tile-id.
//
// S3 ListObjectsV2 returns up to 1000 keys per request, in lexical
// order. Within one zoom level the lexical order is *not* Hilbert
// order, so we collect everything into memory, parse z/x/y, sort by
// tile-id, then write. Even at 56M tiles × ~80 bytes per record, the
// in-memory footprint is ~4 GB — well within a c6i.2xlarge's 16 GB.
// If a future archive grows beyond that we can switch to an external
// sort (sort -k1n -t$'\t').
//
// We shard by zoom prefix (`watercolor/0/`, `watercolor/1/`, …) so the
// outer parallelism is easy: ListObjectsV2 paginates per-prefix and
// each zoom is processed concurrently.

package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/protomaps/go-pmtiles/pmtiles"
)

const maxZoom = 18

type manifestEntry struct {
	TileID uint64
	Key    string
	Size   int64
	ETag   string
}

func runList(ctx context.Context, args []string) error {
	var (
		bucket, prefix, outPath string
		concurrency             int
	)
	parseFlags("list", args, func(fs *flag.FlagSet) {
		fs.StringVar(&bucket, "bucket", "long-term.cache.maps.stamen.com", "source S3 bucket")
		fs.StringVar(&prefix, "prefix", "watercolor/", "key prefix to enumerate")
		fs.StringVar(&outPath, "out", "manifest.tsv", "output manifest path")
		fs.IntVar(&concurrency, "concurrency", 16, "parallel zoom shards")
	})

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return fmt.Errorf("aws config: %w", err)
	}
	client := s3.NewFromConfig(cfg)

	entries := make([]manifestEntry, 0, 64*1024*1024)
	var mu sync.Mutex
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	errCh := make(chan error, maxZoom+1)

	for z := 0; z <= maxZoom; z++ {
		z := z
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			zoomPrefix := fmt.Sprintf("%s%d/", prefix, z)
			zEntries, err := listZoom(ctx, client, bucket, zoomPrefix, z)
			if err != nil {
				errCh <- fmt.Errorf("z=%d: %w", z, err)
				return
			}
			log.Printf("z=%d: %d tiles", z, len(zEntries))
			mu.Lock()
			entries = append(entries, zEntries...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			return err
		}
	}

	log.Printf("sorting %d entries by Hilbert tile-id…", len(entries))
	sort.Slice(entries, func(i, j int) bool { return entries[i].TileID < entries[j].TileID })

	return writeManifest(outPath, entries)
}

func listZoom(ctx context.Context, client *s3.Client, bucket, zoomPrefix string, z int) ([]manifestEntry, error) {
	var out []manifestEntry
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket:       aws.String(bucket),
		Prefix:       aws.String(zoomPrefix),
		RequestPayer: types.RequestPayerRequester,
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, o := range page.Contents {
			key := aws.ToString(o.Key)
			x, y, ok := parseXY(key, zoomPrefix)
			if !ok {
				continue
			}
			out = append(out, manifestEntry{
				TileID: pmtiles.ZxyToID(uint8(z), x, y),
				Key:    key,
				Size:   aws.ToInt64(o.Size),
				ETag:   strings.Trim(aws.ToString(o.ETag), "\""),
			})
		}
	}
	return out, nil
}

// parseXY pulls "x" and "y" from a key of the form
// "{zoomPrefix}{x}/{y}.jpg". Returns false for anything else (e.g.
// stray non-JPEG keys), letting the caller silently skip.
func parseXY(key, zoomPrefix string) (uint32, uint32, bool) {
	rest, ok := strings.CutPrefix(key, zoomPrefix)
	if !ok {
		return 0, 0, false
	}
	rest, ok = strings.CutSuffix(rest, ".jpg")
	if !ok {
		return 0, 0, false
	}
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return 0, 0, false
	}
	x, err := strconv.ParseUint(rest[:slash], 10, 32)
	if err != nil {
		return 0, 0, false
	}
	y, err := strconv.ParseUint(rest[slash+1:], 10, 32)
	if err != nil {
		return 0, 0, false
	}
	return uint32(x), uint32(y), true
}

func writeManifest(path string, entries []manifestEntry) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 4<<20)
	defer w.Flush()
	// Format: tile_id<TAB>key<TAB>size<TAB>etag
	for _, e := range entries {
		if _, err := fmt.Fprintf(w, "%d\t%s\t%d\t%s\n", e.TileID, e.Key, e.Size, e.ETag); err != nil {
			return err
		}
	}
	return nil
}
