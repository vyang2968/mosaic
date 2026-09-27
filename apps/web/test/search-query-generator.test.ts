import { expect, test } from 'bun:test'
import { fallbackQueries } from '../lib/ai/searchQueryGenerator'

test('fallback search queries use the actual ML facet shape and requested item type', () => {
  const alpine = fallbackQueries({ facets: { color: ['pine green', 'slate gray'], style: ['gorpcore'] } }, 'find shoes')
  const academic = fallbackQueries({ facets: { color: ['warm gray'], style: ['light_academia'] } }, 'find shoes')

  expect(alpine).toContain('pine green shoes')
  expect(alpine).toContain('gorpcore shoes')
  expect(alpine.slice(0, 2)).toEqual(['pine green shoes', 'gorpcore shoes'])
  expect(academic).toContain('warm gray shoes')
  expect(academic).not.toEqual(alpine)
  expect(fallbackQueries({ facets: { color: ['blue'] } }, 'red sneakers')).toEqual(['red sneakers'])
})
