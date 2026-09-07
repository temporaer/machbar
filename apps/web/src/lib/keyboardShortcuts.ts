import { isAnySheetOpen } from "../components/BottomSheet";

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * True while unmodified global single-key shortcuts (`j`/`k`/`h`/`l`/`c`/
 * `g`-prefix/etc.) must stay silent: focus is inside an editable control,
 * or a `BottomSheet`/dialog currently owns input. Shared by both keyboard
 * controllers (the global `g`-prefix navigation handler and each page's
 * scope-aware row/outline handler) so there is one place that defines
 * "don't fire a shortcut right now" instead of each handler re-deriving
 * it slightly differently.
 */
export function shouldSuppressGlobalShortcuts(target: EventTarget | null): boolean {
  if (isAnySheetOpen()) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}
