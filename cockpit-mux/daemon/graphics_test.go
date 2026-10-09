//go:build libghostty

package daemon

import (
	"bytes"
	"encoding/base64"
	"testing"
)

const kittyRedRGBA = "/wAA/w=="
const kittyRedPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

func TestShadowGraphicsSeedRehydratesSupportedDirectPlacement(t *testing.T) {
	producer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	producer.Feed([]byte("\x1b[2;3H\x1b_Ga=T,f=32,s=1,v=1,i=71,q=2;" + kittyRedRGBA + "\x1b\\"))

	seed, err := producer.GraphicsSeed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(seed, []byte("a=t,f=32,s=1,v=1,i=71,q=2")) {
		t.Fatalf("graphics seed %q does not include a quiet direct RGBA transfer", seed)
	}
	if !bytes.Contains(seed, []byte("a=p,i=71")) {
		t.Fatalf("graphics seed %q does not include a placement", seed)
	}
	if bytes.Contains(seed, []byte(";OK")) {
		t.Fatalf("graphics seed must not include terminal replies: %q", seed)
	}

	consumer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(seed)
	rehydrated, err := consumer.GraphicsSeed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(rehydrated, []byte("i=71")) || !bytes.Contains(rehydrated, []byte("a=p,i=71")) {
		t.Fatalf("rehydrated graphics seed = %q, want image and placement", rehydrated)
	}
}

func TestShadowGraphicsSeedOmitsOffscreenPlacement(t *testing.T) {
	shadow, err := NewShadow(8, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("\x1b[200;1H\x1b_Ga=T,f=32,s=1,v=1,i=72,q=2;" + kittyRedRGBA + "\x1b\\"))

	seed, err := shadow.GraphicsSeed()
	if err != nil {
		t.Fatal(err)
	}
	if len(seed) != 0 {
		t.Fatalf("offscreen placement must not be rehydrated, got %q", seed)
	}
}

func TestShadowGraphicsSeedReplaysDecodedPNGAsRGBA(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	if err := shadow.ResizeWithPixels(80, 24, 8, 16); err != nil {
		t.Fatal(err)
	}
	png, err := base64.StdEncoding.DecodeString(kittyRedPNG)
	if err != nil {
		t.Fatal(err)
	}
	shadow.Feed([]byte("\x1b_Ga=T,f=100,i=74,q=2;" + base64.StdEncoding.EncodeToString(png) + "\x1b\\"))

	seed, err := shadow.GraphicsSeed()
	if err != nil {
		t.Fatal(err)
	}
	// libghostty decodes PNG in the daemon, so replay must identify the copied
	// pixel buffer as RGBA rather than label it as compressed PNG.
	if !bytes.Contains(seed, []byte("a=t,f=32,s=1,v=1,i=74,q=2")) {
		t.Fatalf("PNG replay seed = %q, want decoded RGBA transfer", seed)
	}
}

func TestGraphicsAreAbsentAfterSnapshotRestore(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("\x1b_Ga=T,f=32,s=1,v=1,i=73,q=2;" + kittyRedRGBA + "\x1b\\"))
	snapshot, err := shadow.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreShadow(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	seed, err := restored.GraphicsSeed()
	if err != nil {
		t.Fatal(err)
	}
	if len(seed) != 0 {
		t.Fatalf("restored daemon must not recover direct graphics, got %q", seed)
	}
}
