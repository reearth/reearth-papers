// pmtiles_writer.go — minimal PMTiles v3 writer built on top of
// go-pmtiles' serialization primitives.
//
// PMTiles v3 layout (spec § 3):
//
//	[ Header  127 bytes                           ]
//	[ Root directory      (gzip-compressed)       ]
//	[ JSON metadata       (gzip-compressed)       ]
//	[ Leaf directories    (gzip-compressed)       ]
//	[ Tile data           (raw tile bytes)        ]
//
// Because each section's offset depends on the size of the section
// before it, and the root + leaf directories themselves can only be
// serialized once every entry is known, we have to write tile data to
// a *temp file* during the build and reassemble at finalize time.
//
// Dedup: tiles with identical content (an extremely common case for
// ocean / blank tiles at high zoom) share a single (offset, length)
// in the directory. We hash each tile with xxhash and look it up in
// a map. Consecutive identical entries are then collapsed via the
// EntryV3.RunLength field.

package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/cespare/xxhash/v2"
	"github.com/protomaps/go-pmtiles/pmtiles"
)

const (
	headerSize = 127
	// 16 KiB is the targetRootLen `pmtiles convert` uses; it balances
	// root-directory fetch size against the number of leaf directories
	// a reader walks.
	rootDirMax = 16384
	// PMTiles TileType enum: 0=Unknown, 1=MVT, 2=PNG, 3=JPEG, 4=WEBP.
	// (Confirm against pmtiles.TileType* constants when wiring up.)
	tileTypeJPEG = 3
)

type pmtilesWriter struct {
	outPath  string
	tempPath string
	temp     *os.File
	bw       *bufio.Writer

	entries []pmtiles.EntryV3
	dedup   map[uint64]uint64 // xxhash → tile-data offset
	bytes   uint64            // bytes written to temp tile-data section
}

func newPMTilesWriter(outPath string, resume bool) (*pmtilesWriter, error) {
	tempPath := outPath + ".tiledata"
	flag := os.O_CREATE | os.O_RDWR
	if !resume {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(tempPath, flag, 0o644)
	if err != nil {
		return nil, err
	}
	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	// When resuming, append after the existing data; otherwise we
	// truncated so size is already 0.
	if _, err := f.Seek(stat.Size(), io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	return &pmtilesWriter{
		outPath:  outPath,
		tempPath: tempPath,
		temp:     f,
		bw:       bufio.NewWriterSize(f, 4<<20),
		bytes:    uint64(stat.Size()),
		dedup:    make(map[uint64]uint64),
	}, nil
}

// AddTile appends a tile to the archive. tileIDs MUST be strictly
// increasing; the build loop guarantees this by reading from a
// pre-sorted manifest with a reordering buffer.
func (w *pmtilesWriter) AddTile(tileID uint64, data []byte) error {
	if n := len(w.entries); n > 0 && tileID <= w.entries[n-1].TileID {
		return fmt.Errorf("non-monotonic tileID: got %d after %d", tileID, w.entries[n-1].TileID)
	}

	hash := xxhash.Sum64(data)
	offset, deduped := w.dedup[hash]
	length := uint32(len(data))

	if !deduped {
		offset = w.bytes
		if _, err := w.bw.Write(data); err != nil {
			return err
		}
		w.bytes += uint64(length)
		w.dedup[hash] = offset
	}

	// Collapse consecutive identical (offset, length) entries via
	// RunLength when their tileIDs are consecutive.
	if n := len(w.entries); n > 0 {
		last := &w.entries[n-1]
		if last.Offset == offset && last.Length == length && last.TileID+uint64(last.RunLength) == tileID {
			last.RunLength++
			return nil
		}
	}
	w.entries = append(w.entries, pmtiles.EntryV3{
		TileID:    tileID,
		Offset:    offset,
		Length:    length,
		RunLength: 1,
	})
	return nil
}

// BytesWritten returns the size of the tile-data section so far.
func (w *pmtilesWriter) BytesWritten() uint64 {
	return w.bytes
}

// Checkpoint persists enough state to resume from a crash.
func (w *pmtilesWriter) Checkpoint(path string, nextIndex uint64) error {
	if err := w.bw.Flush(); err != nil {
		return err
	}
	c := checkpoint{
		NextIndex: nextIndex,
		TempBytes: w.bytes,
	}
	tmp := path + ".tmp"
	data, _ := json.Marshal(c)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Finalize assembles the final .pmtiles by writing
//
//	header | rootDir | metadata | leafDirs | tileData(from temp)
func (w *pmtilesWriter) Finalize() error {
	if err := w.bw.Flush(); err != nil {
		return err
	}

	rootBytes, leavesBytes, _ := pmtiles.BuildDirectories(w.entries, rootDirMax, pmtiles.Gzip)

	metaBytes, err := gzipJSON(defaultMetadata())
	if err != nil {
		return err
	}

	rootOff := uint64(headerSize)
	rootLen := uint64(len(rootBytes))
	metaOff := rootOff + rootLen
	metaLen := uint64(len(metaBytes))
	leavesOff := metaOff + metaLen
	leavesLen := uint64(len(leavesBytes))
	tileDataOff := leavesOff + leavesLen

	header := pmtiles.HeaderV3{
		SpecVersion:         3,
		RootOffset:          rootOff,
		RootLength:          rootLen,
		MetadataOffset:      metaOff,
		MetadataLength:      metaLen,
		LeafDirectoryOffset: leavesOff,
		LeafDirectoryLength: leavesLen,
		TileDataOffset:      tileDataOff,
		TileDataLength:      w.bytes,
		AddressedTilesCount: countTiles(w.entries),
		TileEntriesCount:    uint64(len(w.entries)),
		TileContentsCount:   uint64(len(w.dedup)),
		Clustered:           true,
		InternalCompression: pmtiles.Gzip,
		TileCompression:     pmtiles.NoCompression, // JPEG bytes are not gzipped
		TileType:            tileTypeJPEG,
		MinZoom:             0,
		MaxZoom:             18,
		// World bounding box, e7-scaled. ±85.0511287° is the Web
		// Mercator clamp; ±180° for longitude.
		MinLonE7: -1800000000,
		MinLatE7: -850511287,
		MaxLonE7: 1800000000,
		MaxLatE7: 850511287,
	}
	headerBytes := pmtiles.SerializeHeader(header)
	if len(headerBytes) != headerSize {
		return fmt.Errorf("header size %d != %d", len(headerBytes), headerSize)
	}

	out, err := os.Create(w.outPath)
	if err != nil {
		return err
	}
	defer out.Close()
	bw := bufio.NewWriterSize(out, 4<<20)

	for _, chunk := range [][]byte{headerBytes, rootBytes, metaBytes, leavesBytes} {
		if _, err := bw.Write(chunk); err != nil {
			return err
		}
	}
	if err := bw.Flush(); err != nil {
		return err
	}

	// Stream the temp tile-data file into the output.
	if _, err := w.temp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if _, err := io.Copy(out, w.temp); err != nil {
		return err
	}

	if err := os.Remove(w.tempPath); err != nil {
		fmt.Fprintf(os.Stderr, "warning: remove %s: %v\n", w.tempPath, err)
	}
	return nil
}

// Close flushes pending writes and closes the temp file. Does NOT
// promote the temp file to the final archive — call Finalize() for
// that.
func (w *pmtilesWriter) Close() error {
	if w.temp == nil {
		return nil
	}
	if err := w.bw.Flush(); err != nil {
		w.temp.Close()
		w.temp = nil
		return err
	}
	err := w.temp.Close()
	w.temp = nil
	return err
}

func defaultMetadata() map[string]interface{} {
	return map[string]interface{}{
		"name":        "Stamen Watercolor",
		"description": "Archive of Stamen Design's Watercolor raster tile set, sourced from the long-term.cache.maps.stamen.com S3 bucket.",
		"attribution": "Map tiles by Stamen Design, under CC BY 4.0. Data by OpenStreetMap, under ODbL.",
		"format":      "jpg",
		"type":        "baselayer",
		"version":     "1.0.0",
	}
}

func gzipJSON(meta map[string]interface{}) ([]byte, error) {
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(raw); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func countTiles(entries []pmtiles.EntryV3) uint64 {
	var n uint64
	for _, e := range entries {
		n += uint64(e.RunLength)
	}
	return n
}
