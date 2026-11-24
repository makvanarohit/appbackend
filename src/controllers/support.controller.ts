import type { Response } from 'express';
import type { StaffRequest } from '../middleware/verify-staff';
import { findByShopDomain } from '../repositories/store.repository';
import { SHOP_HOST_PATTERN } from '../services/shopify-auth.service';
import { issueSupportToken } from '../services/support-token.service';

// "my-store", "My-Store.myshopify.com" and "https://my-store.myshopify.com/admin" all mean the same shop.
function cleanShopDomain(raw: string): string {
    let value = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
    if (value !== '' && !value.includes('.')) value = `${value}.myshopify.com`;
    return value;
}

const BAD_DOMAIN = 'Enter the shop domain, for example my-store.myshopify.com';

// POST /internal/support/sessions   body: { shopDomain }
// A staff member (support or admin) asks to look at one shop. The answer has a support token for that
// shop. It ends when the staff login ends. A 'support' role can only READ, an 'admin' can also
// change data (see verifySessionToken). "canEdit" tells the React app which one it is.
export async function openStore(req: StaffRequest, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { shopDomain?: unknown };
    if (typeof body.shopDomain !== 'string' || body.shopDomain.length > 255) {
        res.status(400).json({ error: BAD_DOMAIN });
        return;
    }

    const shopDomain = cleanShopDomain(body.shopDomain);
    if (!SHOP_HOST_PATTERN.test(shopDomain)) {
        res.status(400).json({ error: BAD_DOMAIN });
        return;
    }

    // Only shops that have the app installed. A shop that never installed it has no row,
    // and an uninstalled shop has no token any more.
    const store = await findByShopDomain(shopDomain);
    if (!store || (store.installation_status !== 'installed' && store.installation_status !== 'reinstalled')) {
        res.status(404).json({ error: 'Store not found, or the app is not installed on it' });
        return;
    }

    const staff = req.staff;
    const expiresAt = req.staffSessionExpiresAt;
    if (!staff || expiresAt === undefined) {
        res.status(401).json({ error: 'Please log in again' });
        return;
    }
    // A token that ends in a few seconds is of no use: the page would log out at once.
    if (expiresAt - Math.floor(Date.now() / 1000) < 30) {
        res.status(401).json({ error: 'Your session is about to end. Please log in again.' });
        return;
    }

    console.log(`[support] staff=${staff.username} shop=${store.shop_domain} ip=${req.ip}`);
    res.json({
        shopDomain: store.shop_domain,
        token: issueSupportToken(store.shop_domain, staff, expiresAt),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        canEdit: staff.role === 'admin',
    });
}