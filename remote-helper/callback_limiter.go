package main

import (
	"sync"
	"time"
)

// tokenBucket is the per-project burst limiter (requirement 10), the Go mirror of
// TokenBucket in electron/main/callback/limiter.ts: the bucket holds `capacity`
// tokens and refills continuously at `perSecond`, so a burst of `capacity`
// requests is served and the steady rate is `perSecond`.
type tokenBucket struct {
	mu        sync.Mutex
	capacity  float64
	perSecond float64
	tokens    float64
	last      time.Time
	now       func() time.Time
}

func newTokenBucket(capacity int, perSecond float64, now func() time.Time) *tokenBucket {
	if now == nil {
		now = time.Now
	}
	return &tokenBucket{
		capacity:  float64(capacity),
		perSecond: perSecond,
		tokens:    float64(capacity),
		last:      now(),
		now:       now,
	}
}

// tryTake takes one token if one is available.
func (b *tokenBucket) tryTake() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.now()
	elapsed := t.Sub(b.last).Seconds()
	if elapsed < 0 {
		elapsed = 0
	}
	b.tokens += elapsed * b.perSecond
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = t
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
