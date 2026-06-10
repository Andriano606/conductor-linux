import { describe, expect, it } from 'vitest'
import {
  collectLogicalLines,
  detectMenu,
  type BufferLike,
  type BufferLineLike
} from '../../src/renderer/src/menuDetect'

/** Build a BufferLike from rows; a row given as [text, true] is a wrapped row. */
function makeBuffer(rows: (string | [string, boolean])[], baseY = 0): BufferLike {
  const lines: BufferLineLike[] = rows.map((r) => {
    const [text, isWrapped] = typeof r === 'string' ? [r, false] : r
    return { isWrapped, translateToString: () => text }
  })
  return { baseY, getLine: (y) => lines[y - baseY] }
}

describe('collectLogicalLines', () => {
  it('joins wrapped rows back into one logical line', () => {
    const buf = makeBuffer(['❯ 1. A very long option', ['continued on next row', true], '2. B'])
    expect(collectLogicalLines(buf, 3)).toEqual([
      '❯ 1. A very long optioncontinued on next row',
      '2. B'
    ])
  })

  it('drops trailing blank rows and respects maxScan', () => {
    const buf = makeBuffer(['a', 'b', 'c', '', '  ', ''])
    expect(collectLogicalLines(buf, 6)).toEqual(['a', 'b', 'c'])
    expect(collectLogicalLines(buf, 6, 2)).toEqual(['b', 'c'])
  })

  it('reads only the live screen starting at baseY', () => {
    const buf = makeBuffer(['x', 'y'], 100)
    expect(collectLogicalLines(buf, 2)).toEqual(['x', 'y'])
  })

  it('stops at rows the buffer does not have', () => {
    const buf = makeBuffer(['only'])
    expect(collectLogicalLines(buf, 24)).toEqual(['only'])
  })
})

describe('detectMenu', () => {
  it('detects a permission prompt and strips the (esc) hint', () => {
    const menu = detectMenu([
      'Do you want to create test.ts?',
      '',
      '❯ 1. Yes',
      "  2. Yes, and don't ask again",
      '  3. No, and tell Claude what to do differently (esc)'
    ])
    expect(menu).not.toBeNull()
    expect(menu!.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again",
      'No, and tell Claude what to do differently'
    ])
    expect(menu!.selectedIndex).toBe(0)
    expect(menu!.multiSelect).toBe(false)
  })

  it('detects a menu drawn inside a box frame', () => {
    const menu = detectMenu([
      '╭──────────────────────────╮',
      '│ Do you trust this folder? │',
      '│ ❯ 1. Yes, proceed         │',
      '│   2. No, exit             │',
      '╰──────────────────────────╯'
    ])
    expect(menu).not.toBeNull()
    expect(menu!.options.map((o) => o.label)).toEqual(['Yes, proceed', 'No, exit'])
  })

  it('rejects a prose numbered list (no pointer on any option)', () => {
    expect(
      detectMenu(['Here is the plan:', '1. Refactor the store', '2. Add the panel', ''])
    ).toBeNull()
  })

  it('rejects when the lone ❯ is the idle prompt, not an option row', () => {
    expect(
      detectMenu(['Steps:', '1. First', '2. Second', '', '❯'])
    ).toBeNull()
  })

  it('rejects numbering that does not start at 1 or has gaps', () => {
    expect(detectMenu(['❯ 2. A', '3. B'])).toBeNull()
    expect(detectMenu(['❯ 1. A', '3. B'])).toBeNull()
  })

  it('rejects a single option', () => {
    expect(detectMenu(['❯ 1. Only'])).toBeNull()
  })

  it('tracks the pointer position', () => {
    const menu = detectMenu(['1. A', '❯ 2. B', '3. C'])
    expect(menu!.selectedIndex).toBe(1)
  })

  it('rejects a menu buried under prose (not the active prompt)', () => {
    const lines = ['❯ 1. A', '2. B', ...Array.from({ length: 10 }, (_, i) => `prose line ${i}`)]
    expect(detectMenu(lines)).toBeNull()
  })

  it('accepts a menu followed by blank rows and a key hint', () => {
    const menu = detectMenu(['❯ 1. A', '2. B', '', '↑/↓ to select · enter to confirm · esc to cancel'])
    expect(menu).not.toBeNull()
  })

  it('detects a multi-select menu and strips the checkboxes', () => {
    const menu = detectMenu(['❯ 1. [ ] Alpha', '2. [x] Beta'])
    expect(menu!.multiSelect).toBe(true)
    expect(menu!.options.map((o) => o.label)).toEqual(['Alpha', 'Beta'])
  })

  it('keeps single-select when only some labels look like checkboxes', () => {
    const menu = detectMenu(['❯ 1. [ ] Alpha', '2. Beta'])
    expect(menu!.multiSelect).toBe(false)
  })

  it('handles menus with more than nine options', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `${i === 0 ? '❯ ' : ''}${i + 1}. Option ${i + 1}`)
    const menu = detectMenu(lines)
    expect(menu!.options).toHaveLength(12)
  })

  it('rejects two pointer rows', () => {
    expect(detectMenu(['❯ 1. A', '❯ 2. B'])).toBeNull()
  })

  it('collapses double spaces introduced by wrapped-row joins', () => {
    const menu = detectMenu(['❯ 1. A label  with a wrap seam', '2. B'])
    expect(menu!.options[0].label).toBe('A label with a wrap seam')
  })
})
