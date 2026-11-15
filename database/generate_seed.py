#!/usr/bin/env python3
"""Convert the canonical fixture to normalized SQL rows, without contacting a server."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parent
SOURCE = ROOT / "public/data/hotel-network.json"
SCHEMA = ROOT / "public/data/hotel-network.schema.json"


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, Decimal)):
        if isinstance(value, Decimal) and not value.is_finite():
            raise ValueError("SQL numeric values must be finite.")
        return str(value)
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(f"Unsupported SQL literal type: {type(value).__name__}")
    # Keep sqlcmd control commands and GO outside untrusted string contents.
    value = value.replace("'", "''").replace("\r", "'+NCHAR(13)+N'").replace("\n", "'+NCHAR(10)+N'")
    return "N'" + value + "'"


def identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value):
        raise ValueError("Unexpected SQL identifier.")
    return "[" + value + "]"


def stable_id(prefix: str, values) -> str:
    encoded = json.dumps(values, ensure_ascii=False, default=str, separators=(",", ":"))
    return prefix + "-" + hashlib.sha256(encoded.encode()).hexdigest()[:24]


def normalized_rows(data: dict, schema: dict, fingerprint: str):
    """Yield (table, explicit columns, rows), in dependency order."""
    meta, snapshot = data["meta"], data["bookingSnapshot"]
    if meta["snapshotDate"] != snapshot["asOf"] or not meta["testData"] or not snapshot["testData"]:
        raise ValueError("Expected the canonical, explicitly identified fixture snapshot.")
    if meta["currency"] != "EUR" or any(r["currency"] != "EUR" for r in data["reservations"] + data["roomRates"]):
        raise ValueError("This fixture import requires its original EUR monetary basis.")
    definitions = schema["$defs"]
    lookups = {
        "HotelStatus": ("Hotel", "status"),
        "HotelCategory": ("Hotel", "category"),
        "HousekeepingStatus": ("Room", "housekeeping"),
        "MaintenanceStatus": ("Room", "maintenance"),
        "RoomStateBasis": ("Room", "basis"),
        "FacilityKind": ("Facility", "kind"),
        "FeeUnit": ("Facility", "feeUnit"),
        "CostCategory": ("DailyCost", "category"),
        "Department": ("DailyCost", "department"),
        "CostBasis": ("DailyCost", "basis"),
        "UnitCostBasis": ("UnitCost", "basis"),
        "ActivityBasis": ("DailyFacilityActivity", "basis"),
        "ReservationStatus": ("Reservation", "status"),
        "EventCategory": ("HotelEvent", "category"),
        "EventImportance": ("EventHotelImpact", "importance"),
        "AssessmentSource": ("EventHotelImpact", "source"),
    }
    yield "AmountBasis", ("Code", "Name"), [(meta["amountBasis"], "Net excluding VAT")]
    for table, (definition, field) in lookups.items():
        values = definitions[definition]["properties"][field]["enum"]
        yield table, ("Code", "Name"), [(v, v.replace("_", " ").capitalize()) for v in values]
    amenities = definitions["RoomType"]["properties"]["facilities"]["items"]["enum"]
    yield "RoomAmenity", ("Code", "Name"), [(v, "Wi-Fi" if v == "wifi" else v.replace("_", " ").capitalize()) for v in amenities]
    channel_rates = {}
    for row in data["dailyChannels"]:
        previous = channel_rates.setdefault(row["channel"], row["commissionRate"])
        if previous != row["commissionRate"]:
            raise ValueError("Varying historical commission rates need a new effective-dated migration.")
    yield "BookingChannel", ("Code", "Name", "CommissionRate"), [(code, "OTA" if code == "ota" else code.capitalize(), rate) for code, rate in sorted(channel_rates.items())]
    yield "Currency", ("CurrencyCode", "Name"), [("EUR", "Euro")]
    yield "Organization", ("OrganizationId", "Name", "ReportingCurrencyCode", "AmountBasisCode"), [(meta["id"], meta["name"], meta["currency"], meta["amountBasis"])]
    yield "SourceImport", ("ImportId", "OrganizationId", "SchemaVersion", "IsTestData", "AmountBasis", "PeriodStartDate", "PeriodEndDate", "AsOfDate", "PreviousAsOfDate", "BookingSource"), [(fingerprint, meta["id"], meta["schemaVersion"], True, meta["amountBasis"], meta["reportingPeriod"]["startDate"], meta["reportingPeriod"]["endDate"], snapshot["asOf"], snapshot["previousAsOf"], snapshot["source"])]
    notes = [(fingerprint, kind, index, note) for kind, values in (("meta", meta["notes"]), ("bookingSnapshot", snapshot["notes"])) for index, note in enumerate(values, 1)]
    yield "SourceImportNote", ("ImportId", "NoteKind", "Ordinal", "NoteText"), notes
    policies = [(fingerprint, status, included) for included, values in ((True, snapshot["includedOnBooksStatuses"]), (False, snapshot["excludedStatuses"])) for status in values]
    yield "SourceSnapshotStatusPolicy", ("ImportId", "StatusCode", "IsIncludedOnBooks"), policies
    start, end = date.fromisoformat(meta["reportingPeriod"]["startDate"]), date.fromisoformat(meta["reportingPeriod"]["endDate"])
    yield "CalendarDate", ("Date",), [((start + timedelta(days=index)).isoformat(),) for index in range((end - start).days + 1)]
    countries = {h["country"]: h["countryCode"] for h in data["hotels"]}
    yield "Country", ("CountryCode", "Name"), [(code, name) for name, code in sorted(countries.items())]
    cities = {(row["city"], row["country"]) for row in data["hotels"] + data["events"]}
    city_ids = {key: stable_id("city", key) for key in cities}
    yield "City", ("CityId", "CountryCode", "Name"), [(city_ids[key], countries[key[1]], key[0]) for key in sorted(cities)]
    yield "TimeZone", ("TimeZoneId",), [(v,) for v in sorted({h["timezone"] for h in data["hotels"]})]
    yield "Hotel", ("HotelId", "OrganizationId", "CityId", "TimeZoneId", "Name", "StatusCode", "CategoryCode", "StarRating", "OpenedYear", "Latitude", "Longitude", "CurrencyCode"), [(h["id"], meta["id"], city_ids[(h["city"], h["country"])], h["timezone"], h["name"], h["status"], h["category"], h["starRating"], h["openedYear"], h["coordinates"]["latitude"], h["coordinates"]["longitude"], meta["currency"]) for h in data["hotels"]]
    yield "HotelAddress", ("HotelId", "Line1", "Line2", "PostalCode"), [(h["id"], h["address"]["line1"], h["address"].get("line2"), h["address"]["postalCode"]) for h in data["hotels"] if h.get("address")]
    yield "RoomType", ("RoomTypeId", "HotelId", "Name", "MaxAdults", "MaxChildren", "AreaM2", "BaseRate"), [(r["id"], r["hotelId"], r["name"], r["maxAdults"], r["maxChildren"], r["areaM2"], r["baseRate"]) for r in data["roomTypes"]]
    yield "RoomTypeAmenity", ("RoomTypeId", "AmenityCode"), [(r["id"], amenity) for r in data["roomTypes"] for amenity in r["facilities"]]
    yield "Room", ("RoomId", "RoomTypeId", "Number", "Floor"), [(r["id"], r["roomTypeId"], r["number"], r["floor"]) for r in data["rooms"]]
    yield "RoomDailyState", ("RoomId", "StayDate", "IsOutOfService", "HousekeepingCode", "MaintenanceCode", "MaintenanceNote", "BasisCode"), [(r["roomId"], r["date"], r["occupancy"] == "out_of_service", r["housekeeping"], r["maintenance"], r["maintenanceNote"], r["basis"]) for r in data["dailyRoomStates"]]
    yield "RoomDailyRate", ("RoomTypeId", "StayDate", "NightlyRate"), [(r["roomTypeId"], r["date"], r["nightlyRate"]) for r in data["roomRates"]]
    yield "Facility", ("FacilityId", "HotelId", "KindCode", "Name", "Capacity", "Fee", "FeeUnitCode"), [(f["id"], f["hotelId"], f["kind"], f["name"], f["capacity"], f["fee"], f["feeUnit"]) for f in data["facilities"]]
    windows = []
    for facility in data["facilities"]:
        hours = facility["openingHours"]
        if hours == "24 hours":
            windows.append((facility["id"], 1, "00:00:00", "00:00:00", True))
            continue
        for index, window in enumerate(hours.split("; "), 1):
            match = re.fullmatch(r"(\d{2}:\d{2})–(\d{2}:\d{2})", window)
            if not match:
                raise ValueError(f"Unrecognized opening hours: {hours}")
            opens, closes = match.groups()
            windows.append((facility["id"], index, opens + ":00", closes + ":00", closes <= opens))
    yield "FacilityOpeningWindow", ("FacilityId", "Sequence", "OpensAt", "ClosesAt", "EndsNextDay"), windows
    yield "Restaurant", ("FacilityId", "Cuisine", "BreakfastPrice", "AverageCheck"), [(r["id"], r["cuisine"], r["breakfastPrice"], r["averageCheck"]) for r in data["restaurants"]]
    yield "FacilityDailyActivity", ("FacilityId", "StayDate", "Uses", "Revenue", "BasisCode"), [(r["facilityId"], r["date"], r["uses"], r["revenue"], r["basis"]) for r in data["dailyFacilityActivity"]]
    yield "Reservation", ("ReservationId", "RoomTypeId", "GuestReference", "ChannelCode", "StatusCode", "ArrivalDate", "DepartureDate", "Adults", "Children", "BookedOn", "CancelledOn", "QuotedNightlyRate"), [(r["id"], r["roomTypeId"], r["guestRef"], r["channel"], r["status"], r["arrival"], r["departure"], r["adults"], r["children"], r["bookedOn"], r["cancelledOn"], r["quotedNightlyRate"]) for r in data["reservations"]]
    yield "ReservationRoomAssignment", ("ReservationId", "RoomId"), [(r["id"], r["roomId"]) for r in data["reservations"] if r["roomId"] is not None]
    yield "ReservationNight", ("ReservationId", "StayDate", "RoomRevenue"), [(r["reservationId"], r["date"], r["roomRevenue"]) for r in data["reservationNights"]]
    accounts = sorted({(r["category"], r["department"], r["description"]) for r in data["dailyCosts"]})
    account_ids = {key: stable_id("cost-account", key) for key in accounts}
    yield "CostAccount", ("CostAccountId", "CategoryCode", "DepartmentCode", "Description"), [(account_ids[key], *key) for key in accounts]
    yield "DailyCost", ("CostEntryId", "HotelId", "StayDate", "CostAccountId", "Amount", "BasisCode"), [(r["id"], r["hotelId"], r["date"], account_ids[(r["category"], r["department"], r["description"])], r["amount"], r["basis"]) for r in data["dailyCosts"]]
    yield "UnitCost", ("UnitCostId", "HotelId", "BasisCode", "Amount", "Description"), [(r["id"], r["hotelId"], r["basis"], r["amount"], r["description"]) for r in data["unitCosts"]]
    yield "HotelDailyTarget", ("HotelId", "StayDate", "TargetRooms", "TargetRevenue"), [(r["hotelId"], r["date"], r["budgetSoldNights"], r["budgetRoomRevenue"]) for r in data["dailyPerformance"]]
    positions = []
    for row in data["bookingPositions"]:
        past = row["stayDate"] < snapshot["asOf"]
        positions.append((row["hotelId"], row["stayDate"], row["capturedAsOf"], row["roomsAvailable"], row["actualRooms"] if past else row["roomsOnBooks"], row["actualRoomRevenue"] if past else row["revenueOnBooks"]))
        if not past:
            positions.append((row["hotelId"], row["stayDate"], snapshot["previousAsOf"], None, row["roomsOnBooks7dAgo"], row["revenueOnBooks7dAgo"]))
    yield "BookingPositionSnapshot", ("HotelId", "StayDate", "CapturedAsOf", "RoomsAvailable", "RoomCount", "RoomRevenue"), positions
    venues = {}
    event_venue = {}
    for event in data["events"]:
        key = (city_ids[(event["city"], event["country"])], event["venue"], event["coordinates"]["latitude"], event["coordinates"]["longitude"])
        venue_id = stable_id("venue", key)
        venues[venue_id] = (venue_id, *key)
        event_venue[event["id"]] = venue_id
    yield "EventVenue", ("VenueId", "CityId", "Name", "Latitude", "Longitude"), list(venues.values())
    yield "HotelEvent", ("EventId", "VenueId", "Name", "CategoryCode", "StartDate", "EndDate", "ExpectedAttendance"), [(r["id"], event_venue[r["id"]], r["name"], r["category"], r["startDate"], r["endDate"], r["expectedAttendance"]) for r in data["events"]]
    yield "EventHotelAssessment", ("EventId", "HotelId", "ImportanceCode", "Reason", "DistanceKm", "SourceCode", "AssessedOn"), [(r["eventId"], r["hotelId"], r["importance"], r["reason"], r["distanceKm"], r["source"], r["assessedAt"]) for r in data["eventHotelImpacts"]]


def main() -> None:
    source_bytes = SOURCE.read_bytes()
    fingerprint = hashlib.sha256(source_bytes).hexdigest()
    data = json.loads(source_bytes, parse_float=Decimal)
    schema = json.loads(SCHEMA.read_text())
    output = DIRECTORY / "generated/seed.sql"
    address_extension = DIRECTORY / "generated/extend-hotel-addresses.sql"
    output.parent.mkdir(exist_ok=True)
    counts = {}
    with output.open("w", encoding="utf-8") as stream, address_extension.open("w", encoding="utf-8") as extension:
        stream.write(f"-- Generated from canonical fixture {fingerprint}; no credentials.\nSET NOCOUNT ON;\nGO\n")
        extension.write(f"-- Additive address-only fixture extension {fingerprint}; no ledger replacement.\nSET NOCOUNT ON;\nGO\n")
        for table, columns, rows in normalized_rows(data, schema, fingerprint):
            counts[table] = len(rows)
            stream.write(f"-- {table}: {len(rows)} rows\n")
            column_sql = ",".join(identifier(c) for c in columns)
            for start in range(0, len(rows), 500):
                batch = rows[start:start + 500]
                values = ",\n".join("(" + ",".join(literal(v) for v in row) + ")" for row in batch)
                statement = f"INSERT juyo.{identifier(table)} ({column_sql}) VALUES\n{values};\nGO\n"
                stream.write(statement)
                # Existing imports gain only address facts and a new provenance
                # capture. All canonical room/booking/financial rows stay intact.
                if table in {"SourceImport", "SourceImportNote", "SourceSnapshotStatusPolicy", "HotelAddress"}:
                    extension.write(statement)
        stream.write("PRINT N'Canonical normalized fixture rows inserted.';\nGO\n")
    manifest = {"sourceSha256": fingerprint, "sourceVersion": data["meta"]["schemaVersion"], "tables": counts, "totalRows": sum(counts.values())}
    (DIRECTORY / "generated/seed-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Generated {sum(counts.values()):,} normalized rows across {len(counts)} tables: {output}")


if __name__ == "__main__":
    main()
