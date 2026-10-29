package main

import "sync"

// requestQueue is the unbounded FIFO between the helper's reader goroutine and
// its single worker. Push never blocks, so the reader can always get back to the
// stream (and answer `callback.reply` itself) no matter how long a method runs;
// the worker pops in arrival order, so the existing methods keep exactly the
// ordering they had when the read loop was also the executor.
//
// It is unbounded on purpose (requirement 8): a bounded queue would block the
// reader as soon as it filled, reintroducing the very blocking the split exists to
// remove. Nothing in the client bounds how many requests are in flight (the RPC
// client does not), so the queue's depth is whatever the app has asked for and the
// worker has not yet reached: memory grows with that backlog and is released as the
// worker drains it. If a bound is ever wanted it must live in the client, which
// can wait, never in the reader, which must not.
type requestQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  []Request
	closed bool
}

func newRequestQueue() *requestQueue {
	q := &requestQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push appends a request. It never blocks and is a no-op after close.
func (q *requestQueue) push(req Request) {
	q.mu.Lock()
	if !q.closed {
		q.items = append(q.items, req)
	}
	q.mu.Unlock()
	q.cond.Signal()
}

// pop blocks until a request is available and returns it, or returns ok=false
// once the queue is closed AND drained.
func (q *requestQueue) pop() (Request, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.items) == 0 {
		return Request{}, false
	}
	req := q.items[0]
	q.items[0] = Request{} // release the params for collection
	q.items = q.items[1:]
	if len(q.items) == 0 {
		q.items = nil // drop the backing array grown by a burst
	}
	return req, true
}

// close ends the queue: pop keeps returning what is already queued, then
// reports ok=false.
func (q *requestQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Broadcast()
}

// len is the number of queued, not yet popped requests (test and diagnostics seam).
func (q *requestQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}
