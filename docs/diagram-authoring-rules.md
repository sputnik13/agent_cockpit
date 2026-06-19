# Diagram authoring rules (for agents generating Mermaid)

Drop-in guidance for any agent that emits Mermaid diagrams. The goal is diagrams
that read cleanly — minimal edge crossings, sensible aspect ratio, legible
labels — regardless of the renderer. Agent Cockpit renders Mermaid with the
**ELK** layout engine by default, which already minimizes crossings well; these
rules make the source itself layout-friendly and portable to other renderers.

## Rules

1. **Pick the direction that matches the data flow.** Use `TD`/`TB` (top-down)
   for hierarchies, decision trees, and state machines; use `LR` (left-right)
   for pipelines, sequences of stages, and graphs that are wider than they are
   tall. The wrong direction is the most common cause of a cramped, crossed
   diagram. Example: `flowchart LR`, `stateDiagram-v2` + `direction LR`.

2. **Request ELK for non-trivial graphs.** For flowcharts/state/class diagrams
   with more than ~6 nodes or any back-edges, set the layout explicitly so the
   diagram is crossing-minimized even outside Agent Cockpit:

   ```mermaid
   ---
   config:
     layout: elk
   ---
   flowchart TD
     ...
   ```

   (Harmless where ELK is already the default; ignored by non-graph diagram
   types such as sequence/gantt/pie.)

3. **Declare nodes/edges in reading order — sources before targets.** Layout
   engines use declaration order as a tie-breaker for ranking and placement.
   Define a node before the edges that leave it, and list a node's outgoing
   edges together. Consistent ordering ⇒ fewer crossings.

4. **Group related nodes in `subgraph`s.** Subgraphs constrain layout and keep
   clusters together, which removes long edges that would otherwise cross the
   whole diagram. Give each subgraph a short title.

5. **Keep labels short.** Long node/edge labels widen cells and force the engine
   into awkward spacing. Prefer 1–3 words; move detail into surrounding prose,
   not the diagram. Use `<br/>` only when a deliberate two-line label helps.

6. **Avoid wide fan-out / fan-in.** A single node with many (>5) direct
   children/parents forces crossings. Introduce an intermediate grouping node or
   a subgraph, or split into multiple diagrams.

7. **Reduce back-edges and long jumps.** Edges that point "backwards" (against
   the chosen direction) or skip many ranks are the main source of crossings.
   Order states so the common/forward path is the spine; keep returns (retry,
   cancel, reset) adjacent to their source. If a diagram is mostly back-edges,
   reconsider the direction (rule 1).

8. **One concept per diagram.** Several small, focused diagrams read better than
   one dense graph. Split by lifecycle phase, subsystem, or actor.

9. **Use stable, meaningful node ids; never duplicate edges.** Reuse the same id
   for the same node; duplicate or contradictory edges confuse the layout and
   the reader.

10. **Don't hand-tune pixel positions.** Mermaid has no manual coordinates;
    control layout through the levers above (direction, order, subgraphs, ELK),
    not by fighting the engine.

## Quick checklist

- [ ] Direction matches the flow (TD for hierarchy/state, LR for pipelines).
- [ ] `config: layout: elk` set for graphs with >6 nodes or back-edges.
- [ ] Nodes declared before their outgoing edges; edges grouped by source.
- [ ] Related nodes grouped in titled subgraphs.
- [ ] Labels are short (1–3 words).
- [ ] No node with >5 direct children/parents.
- [ ] Forward path is the spine; returns kept local.
- [ ] Split into multiple diagrams if it's getting dense.
