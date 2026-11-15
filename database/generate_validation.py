#!/usr/bin/env python3
"""Generate independent SQL Server readback checks from the canonical JSON fixture.

No database driver, credentials or frontend imports are used. The generated script
only creates temporary comparison tables and reads the normalized database. It is
safe to run inside the deployment transaction before COMMIT or later on its own.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
TEXT_COLLATION = "Latin1_General_100_BIN2"


def literal(value: Any) -> str:
    """Quote data, including line breaks, without introducing sqlcmd commands."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, Decimal)):
        if isinstance(value, Decimal) and not value.is_finite():
            raise ValueError("Non-finite numeric fixture value")
        return str(value)
    if not isinstance(value, str):
        raise TypeError(f"Unsupported SQL literal type: {type(value).__name__}")
    # A source line equal to GO or :r must never become a sqlcmd directive.
    parts = re.split(r"(\r\n|\r|\n)", value)
    return "+".join(
        "NCHAR(13)+NCHAR(10)" if part == "\r\n" else
        "NCHAR(13)" if part == "\r" else
        "NCHAR(10)" if part == "\n" else
        "N'" + part.replace("'", "''") + "'"
        for part in parts
    )


def ident(value: str) -> str:
    return "[" + value.replace("]", "]]") + "]"


def flattened(rows: list[dict[str, Any]], omit: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        out = {}
        for key, value in row.items():
            if key in omit:
                continue
            if key == "coordinates":
                out.update(value)
            elif isinstance(value, (list, dict)):
                raise ValueError(f"Explicit normalization is required for {key}")
            else:
                out[key] = value
        result.append(out)
    return result


@dataclass
class Comparison:
    name: str
    rows: list[dict[str, Any]]
    actual: str

    def sql(self, error_number: int) -> str:
        if not self.rows:
            raise ValueError(f"Expected canonical collection is empty: {self.name}")
        columns = list(self.rows[0])
        if any(set(row) != set(columns) for row in self.rows):
            raise ValueError(f"Inconsistent expected columns: {self.name}")
        types: dict[str, str] = {}
        for column in columns:
            values = [row[column] for row in self.rows if row[column] is not None]
            if all(isinstance(value, bool) for value in values) and values:
                sql_type = "bit"
            elif all(isinstance(value, int) and not isinstance(value, bool) for value in values) and values:
                sql_type = "bigint"
            elif all(isinstance(value, (int, Decimal)) for value in values) and values:
                sql_type = "decimal(28,6)"
            elif values and all(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) for value in values):
                sql_type = "date"
            else:
                sql_type = f"nvarchar(max) COLLATE {TEXT_COLLATION}"
            types[column] = sql_type
        table = "#Expected_" + self.name
        declarations = ",\n  ".join(f"{ident(column)} {types[column]} NULL" for column in columns)
        select_expected = ", ".join(ident(column) for column in columns)
        # Explicit collation keeps comparisons case-sensitive even if the hosted
        # database uses a case-insensitive default collation.
        select_actual = ", ".join(
            f"CONVERT(nvarchar(max), actual.{ident(column)}) COLLATE {TEXT_COLLATION} AS {ident(column)}"
            if types[column].startswith("nvarchar") else f"actual.{ident(column)}"
            for column in columns
        )
        query = self.actual.strip().rstrip(";")
        chunks = [f"-- {self.name}: {len(self.rows):,} expected rows.\nCREATE TABLE {table} (\n  {declarations}\n);\n"]
        for start in range(0, len(self.rows), 500):
            values = ",\n".join(
                "(" + ",".join(literal(row[column]) for column in columns) + ")"
                for row in self.rows[start:start + 500]
            )
            chunks.append(f"INSERT INTO {table} ({select_expected}) VALUES\n{values};\n")
        chunks.append(f"""
IF (SELECT COUNT_BIG(*) FROM ({query}) AS actual) <> {len(self.rows)}
    THROW {error_number}, N'{self.name}: row count differs from canonical fixture.', 1;
IF EXISTS (
    SELECT {select_expected} FROM {table}
    EXCEPT
    SELECT {select_actual} FROM ({query}) AS actual
) OR EXISTS (
    SELECT {select_actual} FROM ({query}) AS actual
    EXCEPT
    SELECT {select_expected} FROM {table}
)
    THROW {error_number}, N'{self.name}: normalized readback differs from canonical fixture.', 1;
DROP TABLE {table};
PRINT N'Validated {self.name}: {len(self.rows)} rows.';
GO
""")
        return "".join(chunks)


def comparisons(data: dict[str, Any], source_hash: str) -> list[Comparison]:
    result: list[Comparison] = []
    add = lambda name, rows, actual: result.append(Comparison(name, rows, actual))

    add("Hotels", flattened(data["hotels"], ("address",)), """
SELECT h.HotelId AS id,h.Name AS name,c.Name AS city,co.Name AS country,
       co.CountryCode AS countryCode,h.TimeZoneId AS timezone,h.StatusCode AS status,
       h.CategoryCode AS category,h.StarRating AS starRating,h.OpenedYear AS openedYear,
       h.Latitude AS latitude,h.Longitude AS longitude
FROM juyo.Hotel h JOIN juyo.City c ON c.CityId=h.CityId
JOIN juyo.Country co ON co.CountryCode=c.CountryCode
""")
    addresses = [{"hotelId": hotel["id"], "line1": hotel["address"]["line1"],
                  "line2": hotel["address"].get("line2"), "postalCode": hotel["address"]["postalCode"]}
                 for hotel in data["hotels"] if hotel.get("address")]
    add("HotelAddresses", addresses, "SELECT HotelId AS hotelId,Line1 AS line1,Line2 AS line2,PostalCode AS postalCode FROM juyo.HotelAddress")
    add("RoomTypes", flattened(data["roomTypes"], ("facilities",)), """
SELECT t.RoomTypeId AS id,t.HotelId AS hotelId,t.Name AS name,i.Inventory AS inventory,
       t.MaxAdults AS maxAdults,t.MaxChildren AS maxChildren,t.AreaM2 AS areaM2,t.BaseRate AS baseRate
FROM juyo.RoomType t JOIN juyo.RoomTypeInventory i ON i.RoomTypeId=t.RoomTypeId
""")
    amenities = [{"roomTypeId": row["id"], "amenity": amenity} for row in data["roomTypes"] for amenity in row["facilities"]]
    add("RoomTypeAmenities", amenities, "SELECT RoomTypeId AS roomTypeId,AmenityCode AS amenity FROM juyo.RoomTypeAmenity")
    add("RoomRates", flattened(data["roomRates"]), """
SELECT t.HotelId AS hotelId,q.RoomTypeId AS roomTypeId,q.StayDate AS date,
       q.NightlyRate AS nightlyRate,h.CurrencyCode AS currency
FROM juyo.RoomDailyRate q JOIN juyo.RoomType t ON t.RoomTypeId=q.RoomTypeId
JOIN juyo.Hotel h ON h.HotelId=t.HotelId
""")
    add("CurrentRooms", flattened(data["rooms"]), """
SELECT RoomId AS id,HotelId AS hotelId,RoomTypeId AS roomTypeId,Number AS number,Floor AS floor,
       OccupancyCode AS occupancy,HousekeepingCode AS housekeeping,MaintenanceCode AS maintenance,
       MaintenanceNote AS maintenanceNote,StayDate AS date,BasisCode AS basis
FROM juyo.CurrentRooms
""")
    add("DailyRoomStates", flattened(data["dailyRoomStates"]), """
SELECT s.RoomId AS roomId,t.HotelId AS hotelId,s.StayDate AS date,
       CASE WHEN s.IsOutOfService=1 THEN 'out_of_service'
            WHEN allocation.ReservationId IS NOT NULL THEN 'occupied' ELSE 'available' END AS occupancy,
       s.HousekeepingCode AS housekeeping,s.MaintenanceCode AS maintenance,
       s.MaintenanceNote AS maintenanceNote,s.BasisCode AS basis
FROM juyo.RoomDailyState s JOIN juyo.Room r ON r.RoomId=s.RoomId
JOIN juyo.RoomType t ON t.RoomTypeId=r.RoomTypeId
LEFT JOIN juyo.RoomNightAllocation allocation ON allocation.RoomId=s.RoomId AND allocation.StayDate=s.StayDate
""")
    # Opening hours are projected from independent time windows, not a copied
    # display string. Both restaurant subtype and facility must round-trip it.
    opening_hours = """
SELECT FacilityId,
       STRING_AGG(CONVERT(nvarchar(max),CASE WHEN OpensAt=CONVERT(time,'00:00') AND ClosesAt=CONVERT(time,'00:00') AND EndsNextDay=1
           THEN N'24 hours' ELSE CONVERT(nvarchar(5),OpensAt,108)+N'–'+CONVERT(nvarchar(5),ClosesAt,108) END),N'; ')
       WITHIN GROUP (ORDER BY [Sequence]) AS OpeningHours
FROM juyo.FacilityOpeningWindow GROUP BY FacilityId
"""
    add("Facilities", flattened(data["facilities"]), f"""
SELECT f.FacilityId AS id,f.HotelId AS hotelId,f.KindCode AS kind,f.Name AS name,
       f.Capacity AS capacity,hours.OpeningHours AS openingHours,f.Fee AS fee,f.FeeUnitCode AS feeUnit
FROM juyo.Facility f LEFT JOIN ({opening_hours}) hours ON hours.FacilityId=f.FacilityId
""")
    add("Restaurants", flattened(data["restaurants"]), f"""
SELECT r.FacilityId AS id,f.HotelId AS hotelId,f.Name AS name,r.Cuisine AS cuisine,
       f.Capacity AS seats,hours.OpeningHours AS openingHours,r.BreakfastPrice AS breakfastPrice,r.AverageCheck AS averageCheck
FROM juyo.Restaurant r JOIN juyo.Facility f ON f.FacilityId=r.FacilityId
LEFT JOIN ({opening_hours}) hours ON hours.FacilityId=r.FacilityId
""")
    add("FacilityActivity", flattened(data["dailyFacilityActivity"]), """
SELECT f.HotelId AS hotelId,a.FacilityId AS facilityId,a.StayDate AS date,
       a.Uses AS uses,a.Revenue AS revenue,a.BasisCode AS basis
FROM juyo.FacilityDailyActivity a JOIN juyo.Facility f ON f.FacilityId=a.FacilityId
""")
    add("Reservations", flattened(data["reservations"]), """
SELECT r.ReservationId AS id,t.HotelId AS hotelId,r.RoomTypeId AS roomTypeId,a.RoomId AS roomId,
       r.GuestReference AS guestRef,r.ChannelCode AS channel,r.StatusCode AS status,
       r.ArrivalDate AS arrival,r.DepartureDate AS departure,r.Adults AS adults,r.Children AS children,
       totals.RoomRevenue AS roomRevenue,h.CurrencyCode AS currency,r.BookedOn AS bookedOn,
       r.CancelledOn AS cancelledOn,r.QuotedNightlyRate AS quotedNightlyRate,totals.QuotedRevenue AS quotedRevenue
FROM juyo.Reservation r JOIN juyo.RoomType t ON t.RoomTypeId=r.RoomTypeId
JOIN juyo.Hotel h ON h.HotelId=t.HotelId
LEFT JOIN juyo.ReservationRoomAssignment a ON a.ReservationId=r.ReservationId
JOIN juyo.ReservationTotals totals ON totals.ReservationId=r.ReservationId
""")
    add("ReservationNights", flattened(data["reservationNights"]), """
SELECT n.ReservationId AS reservationId,t.HotelId AS hotelId,a.RoomId AS roomId,
       n.StayDate AS date,r.ChannelCode AS channel,n.RoomRevenue AS roomRevenue
FROM juyo.ReservationNight n JOIN juyo.Reservation r ON r.ReservationId=n.ReservationId
JOIN juyo.RoomType t ON t.RoomTypeId=r.RoomTypeId
JOIN juyo.ReservationRoomAssignment a ON a.ReservationId=n.ReservationId
""")
    add("DailyCosts", flattened(data["dailyCosts"]), """
SELECT c.CostEntryId AS id,c.HotelId AS hotelId,c.StayDate AS date,a.CategoryCode AS category,
       a.DepartmentCode AS department,c.Amount AS amount,a.Description AS description,c.BasisCode AS basis
FROM juyo.DailyCost c JOIN juyo.CostAccount a ON a.CostAccountId=c.CostAccountId
""")
    add("MonthlyCosts", flattened(data["costs"]), """
SELECT CONCAT(HotelId,'-',PeriodKey,'-',BasisCode,'-',CategoryCode,'-',DepartmentCode) AS id,
       HotelId AS hotelId,PeriodKey AS period,CategoryCode AS category,DepartmentCode AS department,
       Amount AS amount,Description AS description,BasisCode AS basis FROM juyo.MonthlyCosts
""")
    add("UnitCosts", flattened(data["unitCosts"]), """
SELECT UnitCostId AS id,HotelId AS hotelId,BasisCode AS basis,Amount AS amount,Description AS description FROM juyo.UnitCost
""")
    add("DailyChannels", flattened(data["dailyChannels"]), """
SELECT CONCAT(HotelId,'-',CONVERT(char(10),StayDate,23),'-',ChannelCode) AS id,
       HotelId AS hotelId,StayDate AS date,ChannelCode AS channel,SoldNights AS soldNights,
       GrossRevenue AS grossRevenue,CommissionRate AS commissionRate,AcquisitionCost AS acquisitionCost,BasisCode AS basis
FROM juyo.DailyChannels
""")
    add("MonthlyChannels", flattened(data["channels"]), """
SELECT CONCAT(HotelId,'-',PeriodKey,'-',BasisCode,'-',ChannelCode) AS id,
       HotelId AS hotelId,PeriodKey AS period,ChannelCode AS channel,SoldNights AS soldNights,
       GrossRevenue AS grossRevenue,CommissionRate AS commissionRate,AcquisitionCost AS acquisitionCost,BasisCode AS basis
FROM juyo.MonthlyChannels
""")
    add("DailyPerformance", flattened(data["dailyPerformance"]), """
SELECT HotelId AS hotelId,StayDate AS date,RoomsAvailable AS roomsAvailable,SoldNights AS soldNights,
       RoomRevenue AS roomRevenue,RestaurantRevenue AS restaurantRevenue,RestaurantCovers AS restaurantCovers,
       OtherRevenue AS otherRevenue,BudgetSoldNights AS budgetSoldNights,BudgetRoomRevenue AS budgetRoomRevenue,
       BasisCode AS basis,AncillaryBasisCode AS ancillaryBasis FROM juyo.DailyPerformance
""")
    add("DailyTargets", [{"hotelId": row["hotelId"], "date": row["date"], "targetRooms": row["budgetSoldNights"], "targetRevenue": row["budgetRoomRevenue"]} for row in data["dailyPerformance"]], """
SELECT HotelId AS hotelId,StayDate AS date,TargetRooms AS targetRooms,TargetRevenue AS targetRevenue FROM juyo.HotelDailyTarget
""")
    add("BookingPositions", flattened(data["bookingPositions"]), """
SELECT HotelId AS hotelId,StayDate AS stayDate,CapturedAsOf AS capturedAsOf,StateCode AS state,
       RoomsAvailable AS roomsAvailable,ActualRooms AS actualRooms,ActualRoomRevenue AS actualRoomRevenue,
       RoomsOnBooks AS roomsOnBooks,RevenueOnBooks AS revenueOnBooks,RoomsOnBooks7dAgo AS roomsOnBooks7dAgo,
       RevenueOnBooks7dAgo AS revenueOnBooks7dAgo,Pickup7dRoomNights AS pickup7dRoomNights,
       Pickup7dRevenue AS pickup7dRevenue,TargetRooms AS targetRooms,TargetRevenue AS targetRevenue
FROM juyo.BookingPositions
""")
    snapshots = []
    for row in data["bookingPositions"]:
        past = row["state"] == "past"
        snapshots.append({"hotelId": row["hotelId"], "stayDate": row["stayDate"], "capturedAsOf": row["capturedAsOf"], "roomsAvailable": row["roomsAvailable"], "roomCount": row["actualRooms"] if past else row["roomsOnBooks"], "roomRevenue": row["actualRoomRevenue"] if past else row["revenueOnBooks"]})
        if not past:
            snapshots.append({"hotelId": row["hotelId"], "stayDate": row["stayDate"], "capturedAsOf": data["bookingSnapshot"]["previousAsOf"], "roomsAvailable": None, "roomCount": row["roomsOnBooks7dAgo"], "roomRevenue": row["revenueOnBooks7dAgo"]})
    add("PositionSnapshots", snapshots, """
SELECT HotelId AS hotelId,StayDate AS stayDate,CapturedAsOf AS capturedAsOf,
       RoomsAvailable AS roomsAvailable,RoomCount AS roomCount,RoomRevenue AS roomRevenue FROM juyo.BookingPositionSnapshot
""")
    add("ReportingPeriods", flattened(data["reportingPeriods"]), """
SELECT PeriodKey AS [key],StartDate AS startDate,EndDate AS endDate,Days AS days,Label AS label FROM juyo.ReportingPeriods
""")
    start = date.fromisoformat(data["meta"]["reportingPeriod"]["startDate"])
    end = date.fromisoformat(data["meta"]["reportingPeriod"]["endDate"])
    calendar = [{"date": (start + timedelta(days=offset)).isoformat()} for offset in range((end - start).days + 1)]
    add("CalendarDates", calendar, "SELECT [Date] AS date FROM juyo.CalendarDate")
    add("Events", flattened(data["events"]), """
SELECT e.EventId AS id,e.Name AS name,e.CategoryCode AS category,e.StartDate AS startDate,e.EndDate AS endDate,
       v.Name AS venue,c.Name AS city,co.Name AS country,v.Latitude AS latitude,v.Longitude AS longitude,
       e.ExpectedAttendance AS expectedAttendance
FROM juyo.HotelEvent e JOIN juyo.EventVenue v ON v.VenueId=e.VenueId
JOIN juyo.City c ON c.CityId=v.CityId JOIN juyo.Country co ON co.CountryCode=c.CountryCode
""")
    add("EventAssessments", flattened(data["eventHotelImpacts"]), """
SELECT EventId AS eventId,HotelId AS hotelId,ImportanceCode AS importance,DistanceKm AS distanceKm,
       Reason AS reason,SourceCode AS source,AssessedOn AS assessedAt FROM juyo.EventHotelAssessment
""")
    meta = data["meta"]
    snapshot = data["bookingSnapshot"]
    add("Organization", [{"id": meta["id"], "name": meta["name"], "currency": meta["currency"], "amountBasis": meta["amountBasis"]}], """
SELECT OrganizationId AS id,Name AS name,ReportingCurrencyCode AS currency,AmountBasisCode AS amountBasis FROM juyo.Organization
""")
    add("ImportManifest", [{"importId": source_hash, "organizationId": meta["id"], "schemaVersion": meta["schemaVersion"], "isTestData": meta["testData"], "amountBasis": meta["amountBasis"], "periodStartDate": meta["reportingPeriod"]["startDate"], "periodEndDate": meta["reportingPeriod"]["endDate"], "asOfDate": snapshot["asOf"], "previousAsOfDate": snapshot["previousAsOf"], "bookingSource": snapshot["source"]}], """
SELECT ImportId AS importId,OrganizationId AS organizationId,SchemaVersion AS schemaVersion,
       IsTestData AS isTestData,AmountBasis AS amountBasis,PeriodStartDate AS periodStartDate,
       PeriodEndDate AS periodEndDate,AsOfDate AS asOfDate,PreviousAsOfDate AS previousAsOfDate,BookingSource AS bookingSource FROM juyo.CurrentSourceImport
""")
    notes = [{"importId": source_hash, "noteKind": kind, "ordinal": index + 1, "noteText": note} for kind, source in (("meta", meta), ("bookingSnapshot", snapshot)) for index, note in enumerate(source["notes"])]
    add("ImportNotes", notes, "SELECT n.ImportId AS importId,n.NoteKind AS noteKind,n.Ordinal AS ordinal,n.NoteText AS noteText FROM juyo.SourceImportNote n JOIN juyo.CurrentSourceImport i ON i.ImportId=n.ImportId")
    policy = [{"importId": source_hash, "statusCode": status, "isIncludedOnBooks": included} for included, statuses in ((True, snapshot["includedOnBooksStatuses"]), (False, snapshot["excludedStatuses"])) for status in statuses]
    add("SnapshotStatusPolicy", policy, "SELECT p.ImportId AS importId,p.StatusCode AS statusCode,p.IsIncludedOnBooks AS isIncludedOnBooks FROM juyo.SourceSnapshotStatusPolicy p JOIN juyo.CurrentSourceImport i ON i.ImportId=p.ImportId")
    accounts = sorted({(row["category"], row["department"], row["description"]) for row in data["dailyCosts"]})
    add("CostAccounts", [{"category": category, "department": department, "description": description} for category, department, description in accounts], "SELECT CategoryCode AS category,DepartmentCode AS department,Description AS description FROM juyo.CostAccount")
    countries = sorted({(row["countryCode"], row["country"]) for row in data["hotels"]})
    add("Countries", [{"code": code, "name": name} for code, name in countries], "SELECT CountryCode AS code,Name AS name FROM juyo.Country")
    add("TimeZones", [{"id": zone} for zone in sorted({row["timezone"] for row in data["hotels"]})], "SELECT TimeZoneId AS id FROM juyo.TimeZone")
    add("Currencies", [{"code": meta["currency"]}], "SELECT CurrencyCode AS code FROM juyo.Currency")
    channel_rates: dict[str, Decimal] = {}
    for row in data["dailyChannels"]:
        existing = channel_rates.setdefault(row["channel"], row["commissionRate"])
        if existing != row["commissionRate"]:
            raise ValueError("Canonical channel rates vary; normalized default-rate model needs migration")
    add("ChannelRates", [{"code": code, "commissionRate": rate} for code, rate in sorted(channel_rates.items())], "SELECT Code AS code,CommissionRate AS commissionRate FROM juyo.BookingChannel")
    return result


def lookup_comparisons(schema: dict[str, Any]) -> list[Comparison]:
    """Also retain valid enum values unused by this particular set of records."""
    mappings = {
        "AmountBasis": ("NetworkMeta", "amountBasis"),
        "HotelStatus": ("Hotel", "status"),
        "HotelCategory": ("Hotel", "category"),
        "HousekeepingStatus": ("Room", "housekeeping"),
        "MaintenanceStatus": ("Room", "maintenance"),
        "RoomStateBasis": ("Room", "basis"),
        "RoomAmenity": ("RoomType", "facilities"),
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
    result = []
    for table, (definition, field) in mappings.items():
        prop = schema["$defs"][definition]["properties"][field]
        if "items" in prop:
            prop = prop["items"]
        codes = prop["enum"] if "enum" in prop else [prop["const"]]
        result.append(Comparison("Lookup" + table, [{"code": code} for code in codes], f"SELECT Code AS code FROM juyo.{table}"))
    return result


INTEGRITY_CHECKS = """
-- A disabled/untrusted constraint is not successful validation.
IF EXISTS (SELECT 1 FROM sys.foreign_keys k JOIN sys.schemas s ON s.schema_id=k.schema_id
           WHERE s.name=N'juyo' AND (k.is_disabled=1 OR k.is_not_trusted=1))
    THROW 51901, N'An application foreign key is disabled or untrusted.', 1;
IF EXISTS (SELECT 1 FROM sys.check_constraints c JOIN sys.schemas s ON s.schema_id=c.schema_id
           WHERE s.name=N'juyo' AND (c.is_disabled=1 OR c.is_not_trusted=1))
    THROW 51902, N'An application check constraint is disabled or untrusted.', 1;
IF EXISTS (SELECT 1 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
           WHERE s.name=N'juyo' AND NOT EXISTS (SELECT 1 FROM sys.key_constraints k WHERE k.parent_object_id=t.object_id AND k.type='PK'))
    THROW 51903, N'An application table lacks a primary key.', 1;
IF EXISTS (
    SELECT r.ReservationId FROM juyo.Reservation r
    LEFT JOIN juyo.ReservationNight n ON n.ReservationId=r.ReservationId
    WHERE r.StatusCode IN ('confirmed','checked_in','checked_out')
    GROUP BY r.ReservationId,r.ArrivalDate,r.DepartureDate
    HAVING COUNT(n.StayDate)<>DATEDIFF(day,r.ArrivalDate,r.DepartureDate)
)
    THROW 51904, N'Accepted reservation has incomplete stay-date coverage.', 1;
IF EXISTS (
    SELECT 1 FROM juyo.Reservation r JOIN juyo.ReservationNight n ON n.ReservationId=r.ReservationId
    WHERE r.StatusCode NOT IN ('confirmed','checked_in','checked_out') OR n.StayDate<r.ArrivalDate OR n.StayDate>=r.DepartureDate
)
    THROW 51905, N'Accepted room-night status or arrival/departure bounds are invalid.', 1;
IF EXISTS (
    SELECT 1 FROM juyo.Reservation r JOIN juyo.ReservationRoomAssignment a ON a.ReservationId=r.ReservationId
    JOIN juyo.Room room ON room.RoomId=a.RoomId WHERE room.RoomTypeId<>r.RoomTypeId
)
    THROW 51906, N'Reservation assignment does not match its contracted room type.', 1;
IF EXISTS (
    SELECT allocation.RoomId,allocation.StayDate FROM juyo.RoomNightAllocation allocation
    GROUP BY allocation.RoomId,allocation.StayDate HAVING COUNT_BIG(*)<>1
)
    THROW 51907, N'Accepted room-night inventory overlaps.', 1;
IF EXISTS (
    SELECT 1 FROM juyo.RoomDailyState s JOIN juyo.RoomNightAllocation allocation
      ON allocation.RoomId=s.RoomId AND allocation.StayDate=s.StayDate
    WHERE s.IsOutOfService=1
)
    THROW 51908, N'An out-of-service room has an accepted booking.', 1;
IF EXISTS (
    SELECT 1 FROM juyo.SourceImport i
    WHERE i.ImportedAtUtc IS NULL OR i.ImportedAtUtc>DATEADD(minute,5,SYSUTCDATETIME())
)
    THROW 51909, N'Import audit timestamp is invalid.', 1;
PRINT N'Validated trusted constraints, primary keys, complete stays, assignments and room inventory.';
GO
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "public/data/hotel-network.json")
    parser.add_argument("--schema", type=Path, default=ROOT / "public/data/hotel-network.schema.json")
    parser.add_argument("--output", type=Path, default=ROOT / "database/generated/validate.sql")
    args = parser.parse_args()
    raw = args.source.read_bytes()
    data = json.loads(raw, parse_float=Decimal)
    digest = hashlib.sha256(raw).hexdigest()
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    checks = comparisons(data, digest) + lookup_comparisons(schema)
    sql = """-- Generated from canonical fixture JSON. No credentials are included.
-- Read-only against persistent tables; expected values use temporary tables only.
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO
"""
    sql += f"-- Source SHA-256: {digest}\n"
    sql += "".join(check.sql(51001 + index) for index, check in enumerate(checks))
    sql += INTEGRITY_CHECKS
    sql += f"PRINT N'All {len(checks)} canonical fixture readback comparisons passed.';\nGO\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(sql, encoding="utf-8")
    print(f"Generated {len(checks)} readback comparisons ({sum(len(check.rows) for check in checks):,} expected rows): {args.output}")


if __name__ == "__main__":
    main()
