/** A recovered daemon-crash pane remains mounted as a read-only screen snapshot. */
export function shouldRetainTerminalAfterExit(signal: string | null): boolean {
  return signal === 'daemon-crash';
}
