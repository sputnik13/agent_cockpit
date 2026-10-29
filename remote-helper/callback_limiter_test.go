package main

import (
	"testing"
	"time"
)

// fakeClock is a hand-driven clock for the limiter.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(1_000_000, 0)} }

func TestTokenBucketServesABurstThenRefusesThenRefills(t *testing.T) {
	clock := newFakeClock()
	b := newTokenBucket(10, 10, clock.now)
	for i := 0; i < 10; i++ {
		if !b.tryTake() {
			t.Fatalf("token %d of the initial burst was refused", i+1)
		}
	}
	if b.tryTake() {
		t.Fatal("the 11th immediate request must be refused")
	}
	clock.advance(99 * time.Millisecond) // 0.99 of a token
	if b.tryTake() {
		t.Fatal("a fraction of a token is not a token")
	}
	clock.advance(2 * time.Millisecond) // now 1.01
	if !b.tryTake() {
		t.Fatal("one token has refilled after 100 ms at 10/s")
	}
	if b.tryTake() {
		t.Fatal("only one token had refilled")
	}
}

func TestTokenBucketNeverExceedsItsCapacity(t *testing.T) {
	clock := newFakeClock()
	b := newTokenBucket(3, 100, clock.now)
	clock.advance(time.Hour)
	for i := 0; i < 3; i++ {
		if !b.tryTake() {
			t.Fatalf("token %d refused", i+1)
		}
	}
	if b.tryTake() {
		t.Fatal("an idle hour must not bank more than the capacity")
	}
}

func TestTokenBucketToleratesAClockThatMovesBackwards(t *testing.T) {
	clock := newFakeClock()
	b := newTokenBucket(2, 10, clock.now)
	b.tryTake()
	b.tryTake()
	clock.advance(-time.Minute)
	if b.tryTake() {
		t.Fatal("time going backwards must not mint tokens")
	}
}
