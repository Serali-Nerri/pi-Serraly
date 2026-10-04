/**
 * Stateless tool-card leaf for the background task tools.
 *
 * This is the only module in this package that imports the shared UI kit, and the
 * only one the build bundles (with the kit inlined) instead of emitting it
 * one-to-one from tsc. It renders the card chrome from plain display input: it
 * never reads the task registry, the configuration or the extension factory, so a
 * caller can render any card without touching runtime state.
 */
import type { Component } from '@earendil-works/pi-tui';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import {
  RenderLines,
  renderToolHeader,
  renderToolStatus,
  type ToolCardHeader,
  type ToolCardStatus,
  type ToolCardTheme,
} from 'pi-ui-kit';

export interface BgToolCardModel {
  header?: ToolCardHeader;
  status?: ToolCardStatus;
  /** Owner-coloured body lines; the owner keeps its own sanitizer and theme source. */
  bodyLines?: readonly string[];
}

/** Render one background tool card: shared header, shared status line, owner body. */
export function renderBgToolCard(theme: ToolCardTheme, model: BgToolCardModel): Component {
  return new RenderLines((width) => {
    if (width <= 0) return [];
    return [
      ...(model.header ? renderToolHeader(theme, model.header, width) : []),
      ...(model.status ? renderToolStatus(theme, model.status, width) : []),
      ...(model.bodyLines ?? []).flatMap((line) => wrapTextWithAnsi(line, width)),
    ];
  });
}
