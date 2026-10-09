//go:build libghostty

package daemon

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	ghostty "go.mitchellh.com/libghostty"
	syspng "go.mitchellh.com/libghostty/sys/png"
)

// WTerm applies the same 32 MiB decoded-image ceiling to its Ghostty core and
// DOM overlay. The daemon uses the same per-screen bound so live state cannot
// grow beyond what a reconnecting WTerm can accept.
const (
	kittyImageStorageLimit uint64 = 32 << 20
	kittyTransferChunk            = 3 * 1024 // a whole number of base64 quanta
)

var (
	kittyPNGOnce sync.Once
	kittyPNGErr  error
)

// configureKittyGraphics enables only the direct in-memory image formats that
// WTerm supports. libghostty's PNG decoder is process-global, so install it
// once before a shadow accepts graphics input.
func configureKittyGraphics(terminal *ghostty.Terminal) error {
	kittyPNGOnce.Do(func() { kittyPNGErr = ghostty.SysSetDecodePng(syspng.Decode) })
	if kittyPNGErr != nil {
		return fmt.Errorf("install Ghostty PNG decoder: %w", kittyPNGErr)
	}
	if err := terminal.SetKittyImageStorageLimit(ptrTo(kittyImageStorageLimit)); err != nil {
		return fmt.Errorf("enable Ghostty Kitty image storage: %w", err)
	}
	return nil
}

func ptrTo[T any](value T) *T { return &value }

// GraphicsSeed materializes the daemon's current supported direct-graphics
// state as quiet Kitty protocol bytes for a newly created WTerm core. It reads
// libghostty's public parsed registry; it never observes or reparses the PTY
// byte stream. The snapshot intentionally covers only the current visible
// screen and is not durable across daemon restart, replacement, or handoff.
func (shadow *Shadow) GraphicsSeed() ([]byte, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()

	graphics, err := shadow.terminal.KittyGraphics()
	if err != nil {
		return nil, fmt.Errorf("read Ghostty Kitty graphics: %w", err)
	}
	if graphics == nil {
		return nil, nil
	}
	iterator, err := ghostty.NewKittyGraphicsPlacementIterator()
	if err != nil {
		return nil, fmt.Errorf("create Ghostty Kitty placement iterator: %w", err)
	}
	defer iterator.Close()
	if err := graphics.PlacementIterator(iterator); err != nil {
		return nil, fmt.Errorf("iterate Ghostty Kitty placements: %w", err)
	}

	type placement struct {
		info   *ghostty.KittyGraphicsPlacementInfo
		render *ghostty.KittyGraphicsPlacementRenderInfo
	}
	placements := make([]placement, 0)
	images := make(map[uint32]*ghostty.KittyGraphicsImageInfo)
	for iterator.Next() {
		info, err := iterator.Info()
		if err != nil {
			return nil, fmt.Errorf("read Ghostty Kitty placement: %w", err)
		}
		if info.IsVirtual {
			continue
		}
		image := graphics.Image(info.ImageID)
		if image == nil {
			return nil, fmt.Errorf("Ghostty Kitty placement references missing image %d", info.ImageID)
		}
		render, err := iterator.RenderInfo(image, shadow.terminal)
		if err != nil {
			return nil, fmt.Errorf("resolve Ghostty Kitty placement %d: %w", info.PlacementID, err)
		}
		if !render.ViewportVisible {
			continue
		}
		if _, ok := images[info.ImageID]; !ok {
			imageInfo, err := image.Info()
			if err != nil {
				return nil, fmt.Errorf("read Ghostty Kitty image %d: %w", info.ImageID, err)
			}
			if imageInfo.DataPending {
				continue
			}
			if !supportedKittyFormat(imageInfo.Format) {
				continue
			}
			// Info.Data is borrowed from libghostty. Copy before another terminal
			// operation can invalidate it.
			imageInfo.Data = append([]byte(nil), imageInfo.Data...)
			images[info.ImageID] = imageInfo
		}
		if images[info.ImageID] != nil {
			placements = append(placements, placement{info: info, render: render})
		}
	}
	if len(placements) == 0 {
		return nil, nil
	}

	ids := make([]int, 0, len(images))
	for id := range images {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	var seed []byte
	for _, id := range ids {
		seed = appendKittyTransmit(seed, images[uint32(id)])
	}
	// Explicit placement moves must not alter the cursor restored by the text
	// seed. The replay itself asks for no Kitty replies (q=2), leaving WTerm's
	// established reply channel as the only reverse terminal route.
	seed = append(seed, "\x1b7"...)
	for _, placement := range placements {
		seed = append(seed, "\x1b["...)
		seed = append(seed, strconv.FormatInt(int64(placement.render.ViewportRow)+1, 10)...)
		seed = append(seed, ';')
		seed = append(seed, strconv.FormatInt(int64(placement.render.ViewportCol)+1, 10)...)
		seed = append(seed, 'H')
		seed = appendKittyPlacement(seed, placement.info)
	}
	seed = append(seed, "\x1b8"...)
	return seed, nil
}

func supportedKittyFormat(format ghostty.KittyImageFormat) bool {
	return format == ghostty.KittyImageFormatRGB || format == ghostty.KittyImageFormatRGBA || format == ghostty.KittyImageFormatPNG
}

func appendKittyTransmit(seed []byte, image *ghostty.KittyGraphicsImageInfo) []byte {
	format := 32
	if image.Format == ghostty.KittyImageFormatRGB {
		format = 24
	} else if image.Format == ghostty.KittyImageFormatPNG {
		format = 100
	}
	for offset := 0; offset < len(image.Data); {
		end := min(offset+kittyTransferChunk, len(image.Data))
		more := 0
		if end < len(image.Data) {
			more = 1
		}
		params := "q=2,m=" + strconv.Itoa(more)
		if offset == 0 {
			params = strings.Join([]string{
				"a=t",
				"f=" + strconv.Itoa(format),
				"s=" + strconv.FormatUint(uint64(image.Width), 10),
				"v=" + strconv.FormatUint(uint64(image.Height), 10),
				"i=" + strconv.FormatUint(uint64(image.ID), 10),
				params,
			}, ",")
		}
		seed = append(seed, "\x1b_G"...)
		seed = append(seed, params...)
		seed = append(seed, ';')
		seed = append(seed, base64.StdEncoding.EncodeToString(image.Data[offset:end])...)
		seed = append(seed, "\x1b\\"...)
		offset = end
	}
	return seed
}

func appendKittyPlacement(seed []byte, placement *ghostty.KittyGraphicsPlacementInfo) []byte {
	params := []string{
		"a=p",
		"i=" + strconv.FormatUint(uint64(placement.ImageID), 10),
		"p=" + strconv.FormatUint(uint64(placement.PlacementID), 10),
		"q=2",
	}
	if placement.SourceX != 0 {
		params = append(params, "x="+strconv.FormatUint(uint64(placement.SourceX), 10))
	}
	if placement.SourceY != 0 {
		params = append(params, "y="+strconv.FormatUint(uint64(placement.SourceY), 10))
	}
	if placement.SourceWidth != 0 {
		params = append(params, "w="+strconv.FormatUint(uint64(placement.SourceWidth), 10))
	}
	if placement.SourceHeight != 0 {
		params = append(params, "h="+strconv.FormatUint(uint64(placement.SourceHeight), 10))
	}
	if placement.Columns != 0 {
		params = append(params, "c="+strconv.FormatUint(uint64(placement.Columns), 10))
	}
	if placement.Rows != 0 {
		params = append(params, "r="+strconv.FormatUint(uint64(placement.Rows), 10))
	}
	if placement.XOffset != 0 {
		params = append(params, "X="+strconv.FormatUint(uint64(placement.XOffset), 10))
	}
	if placement.YOffset != 0 {
		params = append(params, "Y="+strconv.FormatUint(uint64(placement.YOffset), 10))
	}
	if placement.Z != 0 {
		params = append(params, "z="+strconv.FormatInt(int64(placement.Z), 10))
	}
	seed = append(seed, "\x1b_G"...)
	seed = append(seed, strings.Join(params, ",")...)
	seed = append(seed, ';', '\x1b', '\\')
	return seed
}
