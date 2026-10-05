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
// The two methods are patched to fall back only in that mismatch case, which
// React never produces on its own: everything else goes straight through.

let warned = false;
function warnOnce(method: string): void {
  if (warned) return;
  warned = true;
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
    if (child.parentNode !== this) {
      warnOnce('removeChild');
      // Wrapped in place: remove it from where it now lives. Already
      // detached (replaced outright): there is nothing left to remove.
      if (child.parentNode && this.contains(child)) removeChild.call(child.parentNode, child);
      return child;
    }
    return removeChild.call(this, child) as T;
  };

  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) {
      warnOnce('insertBefore');
      // Insert before whatever now holds `ref` (the translator's wrapper),
      // or at the end when `ref` was replaced outright: its old position is
      // unknown, and showing the node out of order beats losing the page.
      return insertBefore.call(this, node, childContaining(this, ref)) as T;
    }
    return insertBefore.call(this, node, ref) as T;
  };
}
