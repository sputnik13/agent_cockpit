import { describe, expect, it } from 'vitest';
import {
  mouseSubscribeCmd,
  mouseUnsubscribeCmd,
  parseMouseFlagsValue,
  parseSubscriptionName,
  titleSubscribeCmd,
  titleUnsubscribeCmd,
} from './subscriptions';

describe('subscription command builders', () => {
  it('builds title subscribe/unsubscribe for a window', () => {
    expect(titleSubscribeCmd('@1')).toBe("refresh-client -B 'cockpit-title-@1:@1:#{pane_title}'");
    expect(titleUnsubscribeCmd('@1')).toBe("refresh-client -B 'cockpit-title-@1::'");
  });
  it('builds mouse subscribe/unsubscribe for a pane', () => {
    expect(mouseSubscribeCmd('%3')).toBe(
      "refresh-client -B 'cockpit-mouse-%3:%3:#{mouse_any_flag} #{mouse_sgr_flag}'",
    );
    expect(mouseUnsubscribeCmd('%3')).toBe("refresh-client -B 'cockpit-mouse-%3::'");
  });
});

describe('parseSubscriptionName (routing)', () => {
  it('classifies title names to their window', () => {
    expect(parseSubscriptionName('cockpit-title-@2')).toEqual({ kind: 'title', windowId: '@2' });
  });
  it('classifies mouse names to their pane', () => {
    expect(parseSubscriptionName('cockpit-mouse-%5')).toEqual({ kind: 'mouse', paneId: '%5' });
  });
  it('returns null for unrelated names (round-trips with the builders)', () => {
    expect(parseSubscriptionName('something-else')).toBeNull();
    expect(parseSubscriptionName(titleSubscribeCmd('@9').match(/'([^:]+):/)![1]!)).toEqual({
      kind: 'title',
      windowId: '@9',
    });
  });
});

describe('parseMouseFlagsValue', () => {
  it('parses both flags', () => {
    expect(parseMouseFlagsValue('1 0')).toEqual({ any: true, sgr: false });
    expect(parseMouseFlagsValue('1 1')).toEqual({ any: true, sgr: true });
    expect(parseMouseFlagsValue('0 0')).toEqual({ any: false, sgr: false });
  });
  it('tolerates extra whitespace / missing fields', () => {
    expect(parseMouseFlagsValue('  1   1 ')).toEqual({ any: true, sgr: true });
    expect(parseMouseFlagsValue('')).toEqual({ any: false, sgr: false });
  });
});
