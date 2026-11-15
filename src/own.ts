/**
 * Writing a key as data, never as the prototype.
 *
 * `obj[key] = value` with `key === '__proto__'` calls the `Object.prototype.__proto__` setter: the
 * value becomes the object's prototype instead of an entry. Keys in log records come from
 * application data and from log files (`JSON.parse` keeps `"__proto__"` as an ordinary key), so
 * every place that copies such keys uses {@link setOwn}.
 *
 * @module
 */

/**
 * Set `obj[key] = value` as an own, enumerable data property, even for `__proto__`.
 *
 * @example
 * const out: Record<string, unknown> = {}
 * setOwn(out, '__proto__', { a: 1 })
 * Object.keys(out) // ['__proto__']
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__')
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
  else obj[key] = value
}
