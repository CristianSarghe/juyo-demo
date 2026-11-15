# Offline hotel-network database

This folder provisions the canonical SQL Server data independently of the Angular application. The separate `backend/` now reads these tables and views for the API; the frontend uses that API and has no database driver, password or connection string. API-owned sessions, conversations and operational changes live in the independent `juyo_api` schema, outside this canonical import.

The source is the exact canonical `public/data/hotel-network.json` export, schema version **2.3.0**. Browser-local price changes, room-operation overrides, account sessions and conversations are not part of that read-only fixture and are not imported. Fixture provenance stays in `SourceImport` and ordered notes. The four postal addresses are sample data for fictional hotels; they are not verified business addresses or geocoded matches to the illustrative coordinates.

## Structure

- [Schema and relationships](schema.md): table grains, normalization decisions and an ER diagram.
- [001_normalized.sql](migrations/001_normalized.sql): domain/reference tables, foreign keys, checks, indexes, uniqueness and set-based integrity guards.
- [002_reporting_views.sql](migrations/002_reporting_views.sql): read-only room snapshots, inventory, revenue, channels, expenses, booking positions and financial reports.
- [003_hotel_addresses.sql](migrations/003_hotel_addresses.sql): optional one-to-one hotel postal addresses, with nonempty-line checks and restrictive hotel ownership.
- [fixture-upgrades.json](fixture-upgrades.json): reviewed exact source hashes for the address-only 2.2.2 → 2.3.0 extension. Existing import history and all room/reservation/financial facts remain unchanged.
- [generate_seed.py](generate_seed.py): deterministic normalization of the canonical fixture using exact decimal values.
- [generate_validation.py](generate_validation.py): independent field-by-field readback comparisons against every original collection.
- [constraint-probes.sql](constraint-probes.sql): seven rejected invalid writes and two permitted room-state changes, all rolled back.
- [apply.py](apply.py): encrypted connection, versioned deployment, transactional import and validation.
- `verification-report.json` (local and ignored): actual database inventory and source/migration fingerprints from the latest successful verification. It contains infrastructure identifiers and must not be committed.

There are 50 domain/reference tables, plus `SchemaMigration`. Two indexed join views enforce hotel-scoped room numbers and unique accepted room/date allocations without copying hotel/room identifiers into dependent facts. Fourteen reporting views reconstruct the source's presentation records.

Room-type inventory, current room occupancy, accepted booking totals, daily/monthly channel performance, monthly costs and dashboard metrics are calculated rather than stored as independently editable duplicates. Restaurants extend facilities. Amenities and opening windows use child tables. Booking quotes and accepted nightly revenue stay separate from selling prices. Historical booking-position captures remain immutable observations, including the November 7 comparison; unknown historical capacity remains NULL.

Current commission fractions are constant per booking channel in the source, so they belong to the channel reference table. The generator rejects a fixture with varying historical fractions rather than silently discarding that variation. Such a dataset requires an effective-dated channel-agreement migration before import.

## Run locally

Requirements: Python 3, Microsoft's `sqlcmd`, and the canonical JSON/schema files. No Python package or Angular dependency installation is needed.

Generate reviewable SQL without opening a database connection:

```sh
python3 database/generate_seed.py
python3 database/generate_validation.py
```

Generated SQL and manifests live in ignored `database/generated/`; all inputs and generators remain versionable.

Apply to an explicitly named database:

```sh
python3 database/apply.py \
  --server "your-sql-server,1433" \
  --database "your-database" \
  --user "your-database-user" \
  --apply
```

The password is requested with an echo-free prompt. For an automation process, `JUYO_SQL_PASSWORD` can supply it through the environment. The tool never accepts a password argument or writes it to disk. Certificate validation is enabled by default. `--trust-server-certificate` uses the trust setting explicitly supplied for this database connection; transport encryption remains enabled.

The runner checks the target name and migration fingerprints before writing. An application lock serializes provisioning. Schema changes, seed rows, migration records and all 52 readback comparisons execute in one transaction. A SQL error exits the connection and rolls back uncommitted work. It never drops tables, deletes data, disables constraints or replaces an existing different fixture. The sole registered extension inserts four address rows and a new provenance capture for the exact prior source hash, retaining its complete import history. Any other changed fixture is rejected. Repeating the same apply skips existing matching migrations/imports and validates them again.

Verify the already populated database without persistent writes:

```sh
python3 database/apply.py \
  --server "your-sql-server,1433" \
  --database "your-database" \
  --user "your-database-user" \
  --verify-only
```

Verification uses temporary expected-value tables and reads the persistent model. It checks both directions with `EXCEPT`, exact row counts, original text/decimal/date/null values, unused enum values, accepted-stay completeness, allocation uniqueness and trusted constraints. A second connection confirms the committed manifest and counts; the report contains no credentials.

Add `--probe-constraints` to exercise the database's actual rejection behavior in separate, rollback-only transactions. This also confirms that inspected housekeeping and minor repairs can coexist with accepted bookings. The latest verification report records the actual object counts and comparison results; the original baseline also passed all nine constraint probes.

## Integrity and reporting

All tables have primary keys; relationships have restrictive foreign keys. Check constraints cover nonnegative amounts/counts, geographic bounds, date order, reference-rate ranges, party sizes and opening-window duration. Set-based guards preserve room-type assignments, accepted stay bounds, capacity, in-service inventory and restaurant subtype consistency. Complete accepted-stay coverage is checked after import, because inserting a reservation and its nights requires multiple statements.

Amounts use `decimal(19,2)`, commission fractions `decimal(9,6)`, business dates `date`, and audit timestamps UTC `datetime2(3)`. The source's all-EUR, net-of-VAT basis is preserved; no currency conversions are invented.

Future booking revenue is on the books. Future ancillary activity/costs remain planned, and future actual operating profit is NULL. Channel acquisition is rounded per hotel/date/channel before monthly aggregation and is already included in the expense ledger, so financial summaries do not subtract it twice. Unit-cost references are planning rates, not extra expenses.

Every writing connection must keep the indexed-view settings used in the migrations: `ANSI_NULLS`, `ANSI_PADDING`, `ANSI_WARNINGS`, `ARITHABORT`, `CONCAT_NULL_YIELDS_NULL` and `QUOTED_IDENTIFIER` ON; `NUMERIC_ROUNDABORT` OFF. These are connection settings, not server-wide changes. Any future backend should use a separate least-privilege account and preserve these settings; this task creates no users, grants or frontend integration.

SQL Server references: [primary/foreign keys](https://learn.microsoft.com/en-us/sql/relational-databases/tables/primary-and-foreign-key-constraints), [unique/check constraints](https://learn.microsoft.com/en-us/sql/relational-databases/tables/unique-constraints-and-check-constraints), [indexed-view requirements](https://learn.microsoft.com/en-us/sql/relational-databases/views/create-indexed-views).
