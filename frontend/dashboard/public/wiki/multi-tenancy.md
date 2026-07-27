# Multi-Tenancy and Sites

Anthrimon supports multiple isolated tenants (organizations) on one install, plus per-tenant sites for grouping devices geographically or logically.

## What's isolated per tenant

Devices, sites, remote collectors, alerts and alert rules, credentials, and users are all scoped to one tenant — completely isolated from any other tenant on the same install. Shared platform-wide: the license, platform default settings, and the module/licensing system itself.

## Creating a tenant

Platform admins only: **Platform Admin** → **Tenants** tab → create a tenant with a name and slug. Users are then created inside that tenant (**Platform Admin** → **Users**, selecting the tenant).

## Switching between tenants

Platform admins can act as any tenant via the tenant switcher in the sidebar — while doing so, the UI shows an "Acting as another tenant" banner with a one-click way back to your home tenant.

A regular user can only switch into a tenant they've been explicitly granted access to (**Platform Admin** → user's **Tenant Access** setting) — every user always has implicit access to their own home tenant.

## Site-scoped roles

Beyond a user's tenant-wide role, an admin can grant a narrower role scoped to just one site (e.g. "operator, but only for the London site") without changing what that user can do everywhere else in the tenant.

## Sites

Go to **Admin** → **Sites** to create and name sites, and assign devices to them (bulk "Change site" action is also available from the device list). A device's site is independent of which remote collector it's assigned to — a device can be in one site while its collector is physically deployed at a different one.
