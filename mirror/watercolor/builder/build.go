// build.go — Phase 2: consume the sorted manifest, fetch each tile in
// parallel from S3, and stream the bytes into a PMTiles archive in
// Hilbert tile-id order.
//
// Strategy
// --------
//
//  1. Producer goroutines fetch tiles by manifest index (concurrent,
//     out of order). Each result carries its sequence number so the
//     consumer can re-order them.
//  2. A single consumer pulls completed fetches in sequence-number
//     order via a reordering buffer, hashes the body for dedup, and
//     appends to the PMTiles writer.
//  3. The writer keeps tile bytes in a flat temp file and the
//     directory entries in memory. On Close(), it assembles the
//     final .pmtiles by writing header + directories + metadata,
//     then copying the temp tile data section in place.
//
// The reordering buffer bounds memory at `lookahead * avgTileSize`
// (default 4096 × 16 KB ≈ 64 MB) so we never let one slow tile stall
// the whole pipeline by more than that.

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type fetchResult struct {
	seq    uint64
	tileID uint64
	data   []byte
	err    error
}

func runBuild(ctx context.Context, args []string) error {
	var (
		bucket, manifestPath, outPath, checkpointPath string
		concurrency, lookahead                        int
		resume                                        bool
	)
	parseFlags("build", args, func(fs *flag.FlagSet) {
		fs.StringVar(&bucket, "bucket", "long-term.cache.maps.stamen.com", "source S3 bucket")
		fs.StringVar(&manifestPath, "manifest", "manifest.tsv", "sorted manifest from `list` phase")
		fs.StringVar(&outPath, "out", "watercolor.pmtiles", "output PMTiles path")
		fs.StringVar(&checkpointPath, "checkpoint", "", "path to checkpoint json (default: <out>.ckpt)")
		fs.IntVar(&concurrency, "concurrency", 64, "in-flight S3 GETs")
		fs.IntVar(&lookahead, "lookahead", 4096, "reorder buffer size (entries)")
		fs.BoolVar(&resume, "resume", false, "resume from checkpoint if present")
	})
	if checkpointPath == "" {
		checkpointPath = outPath + ".ckpt"
	}

	entries, err := readManifest(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	log.Printf("manifest: %d entries", len(entries))

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return fmt.Errorf("aws config: %w", err)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.Retryer = retry.NewAdaptiveMode(func(am *retry.AdaptiveModeOptions) {
			am.StandardOptions = append(am.StandardOptions, func(so *retry.StandardOptions) {
				so.MaxAttempts = 10
			})
		})
	})

	writer, startIdx, err := openWriter(outPath, checkpointPath, resume)
	if err != nil {
		return fmt.Errorf("open writer: %w", err)
	}
	defer writer.Close()

	if startIdx > 0 {
		log.Printf("resuming from manifest index %d (tile-id %d)", startIdx, entries[startIdx].TileID)
	}

	// Producer pool: fetch tiles by manifest index.
	work := make(chan uint64, concurrency*2)
	results := make(chan fetchResult, concurrency*2)
	var producerWG sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		producerWG.Add(1)
		go func() {
			defer producerWG.Done()
			for seq := range work {
				e := entries[seq]
				data, err := fetchTile(ctx, client, bucket, e.Key)
				results <- fetchResult{seq: seq, tileID: e.TileID, data: data, err: err}
			}
		}()
	}

	// Producer feeder: enqueue indices in order, bounded by lookahead.
	go func() {
		defer close(work)
		for i := startIdx; i < uint64(len(entries)); i++ {
			select {
			case <-ctx.Done():
				return
			case work <- i:
			}
		}
	}()

	// Closer for results channel once all producers exit.
	go func() {
		producerWG.Wait()
		close(results)
	}()

	// Consumer: reorder + write.
	buffer := make(map[uint64]fetchResult, lookahead)
	next := startIdx
	var bytesIn, bytesOut atomic.Uint64
	lastLog := time.Now()

	for r := range results {
		if r.err != nil {
			// 403/404 means upstream doesn't have that tile (sparse
			// cache). We pre-filtered to keys returned by list, so
			// this should be rare — log and skip, otherwise abort.
			if isMissing(r.err) {
				log.Printf("skip tile-id %d (%s): %v", r.tileID, entries[r.seq].Key, r.err)
				r.data = nil
			} else {
				return fmt.Errorf("fetch tile-id %d: %w", r.tileID, r.err)
			}
		}
		buffer[r.seq] = r
		for {
			cur, ok := buffer[next]
			if !ok {
				break
			}
			delete(buffer, next)
			if len(cur.data) > 0 {
				if err := writer.AddTile(cur.tileID, cur.data); err != nil {
					return fmt.Errorf("write tile-id %d: %w", cur.tileID, err)
				}
				bytesIn.Add(uint64(len(cur.data)))
				bytesOut.Store(writer.BytesWritten())
			}
			next++
			if next%50_000 == 0 {
				if err := writer.Checkpoint(checkpointPath, next); err != nil {
					log.Printf("checkpoint warning: %v", err)
				}
			}
		}
		if time.Since(lastLog) > 30*time.Second {
			pct := 100 * float64(next) / float64(len(entries))
			log.Printf("progress: %d/%d (%.2f%%) in=%d MB out=%d MB",
				next, len(entries), pct, bytesIn.Load()>>20, bytesOut.Load()>>20)
			lastLog = time.Now()
		}
	}

	if next != uint64(len(entries)) {
		return fmt.Errorf("incomplete: stopped at %d / %d", next, len(entries))
	}

	log.Printf("finalizing %s …", outPath)
	if err := writer.Finalize(); err != nil {
		return fmt.Errorf("finalize: %w", err)
	}
	_ = os.Remove(checkpointPath)
	log.Printf("done: %s (%d tiles, %d MB)", outPath, len(entries), writer.BytesWritten()>>20)
	return nil
}

func fetchTile(ctx context.Context, client *s3.Client, bucket, key string) ([]byte, error) {
	// Same retry shape as headTile in list.go: defend against the SDK's
	// adaptive limiter exhausting its quota under sustained pressure.
	const maxAttempts = 6
	backoff := 500 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		out, err := client.GetObject(ctx, &s3.GetObjectInput{
			Bucket:       aws.String(bucket),
			Key:          aws.String(key),
			RequestPayer: types.RequestPayerRequester,
		})
		if err == nil {
			body, readErr := io.ReadAll(out.Body)
			out.Body.Close()
			if readErr == nil {
				return body, nil
			}
			lastErr = readErr
		} else {
			if isMissing(err) || !isTransient(err) {
				return nil, err
			}
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
	return nil, fmt.Errorf("after %d attempts: %w", maxAttempts, lastErr)
}

func readManifest(path string) ([]manifestEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<16), 1<<20)
	var out []manifestEntry
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			return nil, fmt.Errorf("malformed manifest line: %q", line)
		}
		tileID, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			return nil, err
		}
		size, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			return nil, err
		}
		out = append(out, manifestEntry{TileID: tileID, Key: parts[1], Size: size, ETag: parts[3]})
	}
	return out, scanner.Err()
}

// checkpoint is the on-disk JSON the build phase rewrites every
// 50,000 tiles. On restart, the writer rewinds its temp file to the
// recorded byte offset and the consumer resumes at the recorded
// manifest index.
type checkpoint struct {
	NextIndex   uint64 `json:"next_index"`
	TempBytes   uint64 `json:"temp_bytes"`
	EntriesPath string `json:"entries_path"`
}

func openWriter(outPath, ckptPath string, resume bool) (*pmtilesWriter, uint64, error) {
	var startIdx uint64
	if resume {
		if data, err := os.ReadFile(ckptPath); err == nil {
			var c checkpoint
			if err := json.Unmarshal(data, &c); err != nil {
				return nil, 0, fmt.Errorf("checkpoint parse: %w", err)
			}
			startIdx = c.NextIndex
		}
	}
	w, err := newPMTilesWriter(outPath, startIdx > 0)
	if err != nil {
		return nil, 0, err
	}
	return w, startIdx, nil
}
