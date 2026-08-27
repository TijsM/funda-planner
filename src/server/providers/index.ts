import 'server-only';

import { DEFAULT_PROVIDER, PROVIDER_META } from '@data/providers';
import { flux2Flex, flux2Max } from './bfl';
import { fluxGeneralCn, qwenEdit, zImageCn } from './fal';
import { gptImage2, gptImageMini } from './openai';
import type { Provider } from './types';

/** Every provider the server can spend money at, by the id stored on a render
 *  row. The ids are the ones in `src/data/providers.ts` — that file is the list
 *  the browser's picker reads, and it cannot import this one, so the only thing
 *  keeping the two in step is that these objects are built from that metadata
 *  rather than repeating it. `tests/unit/providers.test.ts` checks the two sets
 *  match, because "they are built from it" is only true until someone adds a
 *  Provider here and forgets the entry there. */
export const PROVIDERS: Record<string, Provider> = {
  [flux2Max.id]: flux2Max,
  [flux2Flex.id]: flux2Flex,
  [zImageCn.id]: zImageCn,
  [fluxGeneralCn.id]: fluxGeneralCn,
  [qwenEdit.id]: qwenEdit,
  [gptImageMini.id]: gptImageMini,
  [gptImage2.id]: gptImage2,
};

export { DEFAULT_PROVIDER, PROVIDER_META };

/** Falls back rather than throwing: a render row written before a provider was
 *  renamed, or a request with no provider at all, is every existing user, and
 *  they get exactly what they had before. An unknown id is not an error the
 *  person pressing Generate can do anything about. */
export function providerOf(id: string | null | undefined): Provider {
  return (id ? PROVIDERS[id] : undefined) ?? PROVIDERS[DEFAULT_PROVIDER];
}

export * from './types';
