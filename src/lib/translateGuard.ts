// Keeps page translators from crashing React (facebook/react#11538).
//
// Google Translate (built into Chrome, common on Android) and similar
// extensions replace the text nodes React rendered with their own <font>
// wrappers. React still holds the original nodes, so its next update calls
// insertBefore/removeChild with a node that is no longer a child of the
// parent, the DOM throws NotFoundError, and the ErrorBoundary replaces the
// whole page (Trello: "Failed to execute 'insertBefore' on 'Node'" on the
// Landing page, 2026-10-05).
//
// The two methods are patched to recover only in that case: the node React
// passes was detached, or wrapped under the parent it was called on. Anything
// else (a node from another tree) still throws, so real bugs stay visible.
// Recovery is best effort: a replaced text node's translated copy can stay on
// screen, and an insert whose reference was replaced lands at the end.

const warned = new Set<string>();
function warnOnce(method: string): void {
  if (warned.has(method)) return;
  warned.add(method);
  console.warn(`translateGuard: ${method} on a node moved by another script (page translation?); recovered.`);
}

/** The child of `parent` that contains `node`, or null if `node` is not under `parent`. */
function childContaining(parent: Node, node: Node): Node | null {
  let current: Node | null = node;
  while (current && current.parentNode !== parent) current = current.parentNode;
  return current;
}

export function installTranslateGuard(): void {
  if (typeof Node !== 'function' || !Node.prototype) return;
  const proto = Node.prototype as Node & { __translateGuard?: true };
  if (proto.__translateGuard) return;
  proto.__translateGuard = true;

  const removeChild = proto.removeChild;
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode === null) {
      // Replaced outright and detached: there is nothing left to remove.
      warnOnce('removeChild');
      return child;
    }
    if (child.parentNode !== this && this.contains(child)) {
      // Wrapped in place: remove it from where it now lives.
      warnOnce('removeChild');
      removeChild.call(child.parentNode, child);
      return child;
    }
    return removeChild.call(this, child) as T;
  };

  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) {
      if (ref.parentNode === null) {
        // Replaced outright: its old position is unknown, and showing the
        // node at the end beats losing the page.
        warnOnce('insertBefore');
        return insertBefore.call(this, node, null) as T;
      }
      const holder = childContaining(this, ref);
      if (holder) {
        // Wrapped in place: insert before the wrapper that now holds it.
        warnOnce('insertBefore');
        return insertBefore.call(this, node, holder) as T;
      }
    }
    return insertBefore.call(this, node, ref) as T;
  };
}
