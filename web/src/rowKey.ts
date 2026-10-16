/**
 * The key of an original row: a 64-bit hash (cyrb53's mixing, both halves) of the evidence note that holds it. An import
 * stores every row as the same note text (its columns, sorted, without empty ones), so a row already on the board is
 * recognised whatever entities a newer mapping would see in it. app/ingest.py computes the same key over UTF-16 code
 * units; tests in both languages check the same values.
 */
export function rowKey(note: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < note.length; i++) {
    const ch = note.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}
