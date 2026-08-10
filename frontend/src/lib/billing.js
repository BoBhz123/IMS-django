// Mirrors accounts/billing/keys.py. No 0/O, no 1/I/L — the pairs people confuse when a key
// is read aloud over the phone.
export const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const KEY_LENGTH = 12
const GROUP_SIZE = 4

/** What the user typed, reduced to what the server stores. */
export function normalizeKey(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split('')
    .filter((character) => KEY_ALPHABET.includes(character))
    .join('')
    .slice(0, KEY_LENGTH)
}

export function isCompleteKey(raw) {
  return normalizeKey(raw).length === KEY_LENGTH
}

/** Dash-separated groups of four — the form the key was handed over in. */
export function formatKeyInput(raw) {
  const normalized = normalizeKey(raw)
  const groups = []
  for (let index = 0; index < normalized.length; index += GROUP_SIZE) {
    groups.push(normalized.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}
