=== PagePoster Bridge ===
Contributors: pageposter
Requires at least: 5.6
Requires PHP: 8.0
Stable tag: 0.2.1
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

Authenticated static PagePoster page/post storage with durable operation identities and atomic conditional updates.

== Installation ==
Build using Node: node wordpress/pageposter-bridge/build-zip.cjs
Install and activate the supplied PagePoster Clean Links ZIP first.
Upload pageposter-bridge-0.2.1.zip in WordPress Plugins > Add New > Upload Plugin, then activate it.
Single-site WordPress, HTTPS, PHP 8.0+, mysqli/mysqlnd, DOM, standard database configuration and InnoDB tables are required.
The database account must directly demonstrate TRIGGER or ALL privileges for the posts and both Bridge tables before trigger absence can be trusted.
Role-only grants, partial revokes and ambiguous database wildcard grants are unsupported. For database-level names containing _ or %, use explicitly escaped literal scope, or exact table grants. The plugin never changes database grants.
Use an Application Password for an account with unfiltered_html plus the exact create/edit/publish permissions needed.
No remote installation, no arbitrary PHP execution, no plugin installation endpoint and no credentials are stored by this plugin.

== Scope ==
Scoped native Classic Editor publication uses post-new.php?pageposter_operation={UUID}, preserves the entered title/content bytes and commits through the same operation ledger as REST. Its Publish submission requires an authenticated HTTPS administrator session, an operation-bound nonce and current create/publish/unfiltered_html capabilities. Ordinary WordPress editors are unchanged. Core may create an empty auto-draft while opening its editor; the published managed page is created once by the Bridge ledger.
Only created or explicitly adopted posts in the managed registry can be changed. The content must contain exactly one real div with the exact id pp-landing or legacy pp-universal-pl.
Adoption requires an exact authenticated snapshot hash and current edit permission. It registers the existing marked page without changing content, title, status or modified time. The plugin does not adopt unmarked pages, change WordPress settings, activate plugins, or remove robots directives.
The static write path bypasses WordPress save/transition hooks, taxonomy defaults, sanitization and standard revision creation.
Previous raw snapshots are retained in the Bridge operation ledger. There is no automatic restore endpoint.
Public rendering, plugin compatibility, caches and outbound links must be checked after a committed write.
This build has PHP unit/contract tests. A live WordPress/MySQL concurrent-write pilot has not yet been run.

== API ==
REST namespace: pageposter/v1
GET status
POST operations
GET operations/{operationId}
GET pages/{postId} (managed only)
GET inspect/{postId} (editable raw snapshot, including unmanaged pages)
POST operations accepts kind=adopt with operationId, postType, postId, expectedContentHash only.
Readiness requires Clean Links VERSION 1.1.1 and contact-schemes/exact-wrapper-boundary feature constants.
Status includes packageIntegrity: SHA-256 of every installed .php file under Bridge and Clean Links, keyed by relative path. The PagePoster server compares the exact file sets and bytes to its supplied Bridge 0.2.1 and Clean Links 1.1.1 ZIPs before enabling writes; missing, modified, extra or unreadable runtime files fail readiness. Readme/license/build files are outside this runtime-byte scope. Reinstall the supplied ZIPs if checksums differ. The reporter and its own source are hashed without an embedded expected digest, avoiding a self-referential checksum.
This authenticated evidence detects package drift; a malicious or compromised WordPress host can falsify its response, so it is not remote security attestation. Rendering and live compatibility remain separate checks.
Every endpoint requires HTTPS and verified Application Password authentication.
Keep the same operationId and identical payload during reconciliation. Never change the operationId merely because a response timed out.
A GET operation 404 can also mean its transaction is still in flight.
The operation result is historical. Later manual saves may differ; read the page snapshot before the next change.

== Retention ==
Deactivation and removal retain the two Bridge tables. Deleting the ledger removes idempotency history and must not be done while old operations may be retried.

== Changelog ==
= 0.2.1 =
Scoped native Classic Editor publishing with the shared idempotent writer and safe structured operation result.
= 0.2.0 =
Exact-snapshot adoption and concrete plugin version/features; byte-preserving managed association.
Initial static-content Bridge. Application Password permissions, explicit operation ledger, InnoDB compare-and-swap and exact-byte readback.
