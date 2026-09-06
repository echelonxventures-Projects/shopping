// Catalog module — AetherModule contract (plug-and-play, billable, configurable).
import { wrapModule, meteredApi } from '@aether/kernel-module/src/adapters.ts';
import { CatalogService } from './index.ts';
import type { CatalogPack } from './index.ts';

export default wrapModule({
  serviceDir: 'services/catalog',
  imports: async () => ({ CatalogService }),
  build: (imports, _host, packs) => {
    const S = (imports as { CatalogService: typeof CatalogService }).CatalogService;
    const pack = Object.values(packs)[0] as CatalogPack;
    return new S({ engineLikeStorage(): unknown { return null; } } as never, pack, 'marketplace-sku', 'offer-id');
  },
  api: (raw, meter, _imports) => {
    const svc = raw as CatalogService;
    const base: Record<string, unknown> = {
      createProduct: (t: string, a: Record<string, unknown>, al?: string[]) => (meter('product.created'), svc.createProduct(t, a, al)),
      addOffer: (t: string, p: string, o: Parameters<CatalogService['addOffer']>[2]) => (meter('offer.added'), svc.addOffer(t, p, o)),
      buyBox: (t: string, p: string, f?: { market?: string | null }) => svc.buyBox(t, p, f),
      listOffers: (t: string, p: string) => svc.listOffers(t, p),
      displayConfig: (f: { tenant?: string | null; market?: string | null }) => svc.displayConfig(f),
      __raw: svc,
    };
    return meteredApi(base, meter, {});
  },
});
