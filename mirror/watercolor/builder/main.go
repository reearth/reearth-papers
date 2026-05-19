// builder is a two-phase pipeline that snapshots Stamen Watercolor
// raster tiles from the requester-pays S3 bucket
// `long-term.cache.maps.stamen.com` into a single PMTiles archive.
//
//	builder list  --bucket … --prefix … --out manifest.tsv
//	builder build --bucket … --manifest manifest.tsv --out watercolor.pmtiles
//
// The two phases are split so the (cheap, fast, easily restartable)
// list step can run independently from the (long, expensive, must-
// resume) build step. The manifest is the source of truth for which
// (z, x, y) tiles to include and is sorted by Hilbert tile-id ahead
// of time so the build step is a straight sequential pass.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if len(os.Args) < 2 {
		usage()
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "list":
		if err := runList(ctx, args); err != nil {
			log.Fatalf("list: %v", err)
		}
	case "build":
		if err := runBuild(ctx, args); err != nil {
			log.Fatalf("build: %v", err)
		}
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", cmd)
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: builder <list|build> [flags]

Subcommands:
  list   Enumerate S3 objects and write a Hilbert-sorted manifest.
  build  Stream tiles from S3 into a PMTiles archive.

Run "builder <subcommand> -h" for subcommand-specific flags.`)
	os.Exit(2)
}

// parseFlags is a small helper that wraps flag.FlagSet boilerplate.
func parseFlags(name string, args []string, register func(*flag.FlagSet)) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	register(fs)
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}
	return fs
}
