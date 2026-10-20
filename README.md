# PL Receive & Sort

Receiving and truck-unload sorting in one scan flow. It combines **PL Bulk Receiving** and **PO Sort**.

**Flow:** scan **PO** → the **pallet number** appears in a big sticky banner → scan **SKU** → scan or type **Qty** → repeat SKU/Qty → **Saved** tab → **Upload all to ShipHero**.

The pallet lookup runs in the background as soon as the PO is recognized. The cursor jumps straight to SKU, so receiving never waits on sorting.

## Pallet banner

| Banner | Meaning |
|---|---|
| Pink, big number | New pallet for this PO |
| Purple, big number | PO was already on this pallet (rescan or another device) |
| Red flag **PRIORITY** + screen flash | ShipHero `packing_note` contains "priority"/"push" (same rule as PO Sort) |
| **FULL** | All 20 pallets used. See a lead for overflow |
| **?** + Retry | Sort server unreachable. Keep receiving, tap Retry |
| — No truck | Tap **Start Truck** first (pallets restart at 1) |

FAI-hold POs still get a pallet, because the freight still has to be staged. The receiving side stays blocked until FAI is done, same as before.

**Pallets** tab: every PO on the current truck with its pallet, from all devices (refreshes every 8 s), plus units saved on this device.

## Shared with PO Sort

This app uses the **same Supabase project and `assign_pallet` function** as PO Sort (`public/config.js`). PO Sort phones and Receive & Sort phones on the same truck get the same pallet numbers, so you can switch over gradually. No Supabase schema changes are needed.

PO validation now comes from the receiving side's ShipHero preload. PO Sort's `validate-po` edge function and `sync-pos` cache aren't needed here.

## Receiving (unchanged from PL Bulk Receiving)

Open POs preload on start. Location defaults to `Receiving` and only changes when a location is scanned. Split labels (base SKU + size barcode) are supported. Over-receive needs a second Enter. Scans are saved on the device. Upload does `inventory_add` into the location (tagged reason) and then `purchase_order_update`, with no double-posting on retries. See the PL Bulk Receiving README for details.

Device storage uses a new key (`plrs.v1`), so this app and the old Receiving app can run side by side on one device without sharing queues.

## Deploy (new Netlify site)

1. Create a repo (e.g. `Pinklily-projects/pl-receive-sort`), push this folder, and connect it as a new Netlify site. No build command is needed: `publish = public`, `functions = netlify/functions`.
2. Set these environment variables:
   - `SHIPHERO_REFRESH_TOKEN`: the same one the Receiving app uses (needs PO edit + inventory rights)
   - `APP_PIN`: receivers enter it once under ⚙ Settings
   - `DEFAULT_LOCATION` (optional, default `Receiving`), `OPEN_PO_DAYS` (optional, default 180)
3. On each device, open the site, enter the PIN and **receiver initials** (shown in the pallet log), then Share → **Add to Home Screen**.

`resetPin` in `public/config.js` (default `0901`) guards **New Truck** while a truck is in progress.
