/** Typed element lookup. (Cast via unknown: TS 6 DOM typings reject some direct element casts.) */
export function byId<T>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as unknown as T;
}

/** Typed querySelectorAll. */
export function queryAll<T>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(selector)) as unknown as T[];
}
