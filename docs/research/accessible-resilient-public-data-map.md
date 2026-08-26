# Accessible and resilient public-data map requirements

Research for **“Research accessible and resilient public-data map requirements”**. Sources are primary standards and first-party guidance; WCAG is normative, while WAI tutorials and Core Web Vitals are implementation guidance and product thresholds.

## Decision

The launch specification should make **WCAG 2.2 Level AA conformance across the complete core journey** a release gate, and treat the map as an enhancement to an equivalent HTML result rather than as the result itself. Performance and failure behaviour are product requirements beyond WCAG: the selected place, geography, offence, period, recorded count, trend, comparison and limitations must remain usable if map rendering or an optional remote service fails.

## Requirements to put in the launch specification

### 1. Conformance scope and verification

- Conform to every applicable WCAG 2.2 A and AA success criterion on every state in the core journey, including loading, empty, ambiguous-place and error states. W3C recommends WCAG 2.2 as the current target; conformance applies to complete pages and complete processes, not isolated components ([WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/)).
- Gate release with automated checks **and** manual keyboard, zoom/reflow, screen-reader and forced-colour/high-contrast checks. Automated tooling cannot establish WCAG conformance on its own because criteria such as equivalent purpose, meaningful order and understandable labels require human judgement.

### 2. The map is never the only route

- Render an ordinary HTML result alongside (or immediately reachable from) the map. It must expose the selected official geography, offence and period; recorded count and trend; the chosen comparison; interpretive limitations; and a navigable list/table of relevant areas and values. Changing a filter updates both representations. The HTML result must not depend on the map library successfully loading.
- Give the map a concise accessible name/description and associate it with the structured result. WAI classifies maps as complex images and calls for a short identification plus a long textual representation of the essential information; structured information should retain headings/table semantics rather than being flattened into one `aria-describedby` string ([WAI Complex Images tutorial](https://www.w3.org/WAI/tutorials/images/complex/)).
- Every map-only action needed by the journey (selecting an area, inspecting a value, changing the extent) needs a keyboard-operable HTML equivalent, and every dragging action needs a non-drag single-pointer method unless essential. Do not put every polygon into the page tab order. The list/table is the primary assistive interaction; any custom interactive-map controls that remain must have names, roles, states, a meaningful focus order, predictable keyboard operation, visible focus, and no keyboard trap ([WCAG 2.2, 1.1.1, 2.1.1, 2.1.2, 2.4.3, 2.5.7 and 4.1.2](https://www.w3.org/TR/WCAG22/)).

### 3. Visual, responsive and input acceptance criteria

- Meaning is never encoded by colour alone. Selected areas, ranges and warnings also use text, symbols, patterns or borders. Text meets 4.5:1 contrast (3:1 for large text); meaningful UI boundaries, focus indicators and graphical objects meet 3:1 against adjacent colours ([WCAG 2.2, 1.4.1, 1.4.3 and 1.4.11](https://www.w3.org/TR/WCAG22/)).
- Text can resize to 200% without loss of content or function, content reflows at 320 CSS px width without two-dimensional scrolling, and WCAG's specified user text-spacing overrides do not clip, overlap or lose content. A genuinely two-dimensional map/table may qualify for the reflow exception, but the core result around it still reflows and remains usable ([WCAG reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html); [resize-text guidance](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html); [text-spacing guidance](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)).
- Controls have a minimum 24 by 24 CSS px target or sufficient spacing under WCAG's exceptions; for this mobile-first release, use **44 by 44 CSS px as the project default** for primary controls, while recognising that 44 px is a usability choice stricter than the AA minimum ([WCAG target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
- Focus is visible and is not entirely hidden by sticky headers, drawers or map overlays. Opening/closing panels and resolving place suggestions moves or restores focus predictably ([WCAG 2.2 focus-not-obscured guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)).

### 4. Motion

- No auto-moving, blinking or updating presentation persists for more than five seconds without pause/stop/hide controls, unless essential ([WCAG pause/stop/hide guidance](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)).
- As a project-level requirement beyond AA, honour `prefers-reduced-motion: reduce`: remove smooth map flights, animated count-up, parallax and non-essential transitions; update immediately while preserving state and focus. The CSS media feature represents the user's request to minimise non-essential motion ([W3C Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)).

### 5. Loading, errors and degraded operation

- Loading, result-count changes, empty results and failures are exposed as programmatic status messages without unexpectedly moving focus. Errors are identified in text, explain what failed, preserve the user's selections, and offer a retry or the next usable route ([WCAG status-messages guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html); [error-identification guidance](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)).
- If the basemap, tiles or map JavaScript fails, show a compact “Map unavailable” notice and keep place search, filters, the complete HTML result, comparison and limitations operational. A failed map must not blank the page or discard state.
- If any optional external service fails, the deterministic explorer is unaffected. No launch-critical request should depend on that service.
- If the core dataset itself cannot load, do not display stale-looking zeroes. Show an explicit unavailable state, last-refresh metadata if known, retry, and methodology/source links.
- Test these states deliberately by blocking map assets, simulating offline/timeout/HTTP failure for each request, throttling the network, and navigating each state by keyboard and screen reader.

### 6. Measurable performance gate

- Adopt the Core Web Vitals “good” thresholds as the production target on both mobile and desktop: **LCP ≤2.5 s, INP ≤200 ms and CLS ≤0.1 at the 75th percentile**. Google defines these as field metrics and applies the same thresholds across devices ([Core Web Vitals threshold methodology](https://web.dev/articles/defining-core-web-vitals-thresholds)).
- Before sufficient field traffic exists, use repeatable mobile lab tests as a release proxy, record the device/network profile, and require no regression across the core journey. Lab results are a proxy, not proof of the 75th-percentile field target.
- Load the textual controls and result before non-essential map assets; reserve map/result dimensions to prevent layout shifts; lazy-load detail that is outside the initial journey. A slow map must not block place search or the first meaningful result.

## Release evidence

The implementation ticket should require a compact evidence bundle:

1. a WCAG 2.2 A/AA checklist for the complete core journey and all failure states;
2. keyboard-only and screen-reader walkthroughs on one current desktop browser and one current mobile platform;
3. 200% text resize, 320 CSS px reflow, forced-colour/high-contrast, non-colour and reduced-motion checks;
4. screenshots or test output for map-resource failure, data failure, slow loading and empty results; and
5. recorded mobile/desktop performance results plus production Core Web Vitals monitoring when traffic permits.

These are launch gates for the specified journey, not a claim that one test matrix proves universal accessibility or reliability.
