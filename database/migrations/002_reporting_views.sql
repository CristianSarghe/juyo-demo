/*
  Read-only reporting projections over the normalized facts in 001.
  Monetary facts are EUR net of VAT in the current fixture; no selling quote is
  used to reprice an accepted reservation night. The current source manifest
  determines the business date rather than the SQL Server's wall clock.

  Source mapping: StayDate -> date (bookingPositions: stayDate), PeriodKey ->
  period/key, *Code -> the corresponding fixture enum. CurrentRooms.RoomId maps
  to rooms.id; ReservationTotals supplies the two derived reservation amounts.
  Monthly synthetic fixture IDs are intentionally not persisted as domain keys.
*/

CREATE VIEW juyo.CurrentSourceImport
AS
WITH RankedImports AS (
    SELECT
        i.ImportId,
        i.OrganizationId,
        i.SchemaVersion,
        i.IsTestData,
        i.AmountBasis,
        i.PeriodStartDate,
        i.PeriodEndDate,
        i.AsOfDate,
        i.PreviousAsOfDate,
        i.BookingSource,
        i.ImportedAtUtc,
        ROW_NUMBER() OVER (
            PARTITION BY i.OrganizationId
            ORDER BY i.ImportedAtUtc DESC, i.ImportId DESC
        ) AS ImportRank
    FROM juyo.SourceImport AS i
)
SELECT
    ImportId, OrganizationId, SchemaVersion, IsTestData, AmountBasis,
    PeriodStartDate, PeriodEndDate, AsOfDate, PreviousAsOfDate,
    BookingSource, ImportedAtUtc
FROM RankedImports
WHERE ImportRank = 1;
GO

CREATE VIEW juyo.ReportingDates
AS
SELECT i.OrganizationId, d.[Date] AS StayDate, i.AsOfDate, i.PreviousAsOfDate
FROM juyo.CurrentSourceImport AS i
INNER JOIN juyo.CalendarDate AS d
    ON d.[Date] BETWEEN i.PeriodStartDate AND i.PeriodEndDate;
GO

CREATE VIEW juyo.ReportingPeriods
AS
WITH Months AS (
    SELECT DISTINCT DATEFROMPARTS(YEAR(StayDate), MONTH(StayDate), 1) AS MonthStart
    FROM juyo.ReportingDates
)
SELECT
    CONVERT(char(7), MonthStart, 126) AS PeriodKey,
    MonthStart AS StartDate,
    EOMONTH(MonthStart) AS EndDate,
    DAY(EOMONTH(MonthStart)) AS Days,
    CONCAT(
        CASE MONTH(MonthStart)
            WHEN 1 THEN N'January' WHEN 2 THEN N'February' WHEN 3 THEN N'March'
            WHEN 4 THEN N'April' WHEN 5 THEN N'May' WHEN 6 THEN N'June'
            WHEN 7 THEN N'July' WHEN 8 THEN N'August' WHEN 9 THEN N'September'
            WHEN 10 THEN N'October' WHEN 11 THEN N'November' WHEN 12 THEN N'December'
        END,
        N' ', YEAR(MonthStart)
    ) AS Label
FROM Months;
GO

CREATE VIEW juyo.RoomTypeInventory
AS
SELECT rt.RoomTypeId, COUNT(r.RoomId) AS Inventory
FROM juyo.RoomType AS rt
LEFT JOIN juyo.Room AS r ON r.RoomTypeId = rt.RoomTypeId
GROUP BY rt.RoomTypeId;
GO

CREATE VIEW juyo.ReservationTotals
AS
SELECT
    r.ReservationId,
    CAST(COALESCE(SUM(n.RoomRevenue), 0) AS decimal(19,2)) AS RoomRevenue,
    CAST(r.QuotedNightlyRate * DATEDIFF(day, r.ArrivalDate, r.DepartureDate)
        AS decimal(19,2)) AS QuotedRevenue
FROM juyo.Reservation AS r
LEFT JOIN juyo.ReservationNight AS n ON n.ReservationId = r.ReservationId
GROUP BY r.ReservationId, r.QuotedNightlyRate, r.ArrivalDate, r.DepartureDate;
GO

CREATE VIEW juyo.RoomDailyStates
AS
SELECT
    s.RoomId,
    rt.HotelId,
    s.StayDate,
    CAST(CASE
        WHEN s.IsOutOfService = 1 THEN 'out_of_service'
        WHEN n.ReservationId IS NOT NULL THEN 'occupied'
        ELSE 'available'
    END AS varchar(32)) AS OccupancyCode,
    s.HousekeepingCode,
    s.MaintenanceCode,
    s.MaintenanceNote,
    s.BasisCode
FROM juyo.RoomDailyState AS s
INNER JOIN juyo.Room AS r ON r.RoomId = s.RoomId
INNER JOIN juyo.RoomType AS rt ON rt.RoomTypeId = r.RoomTypeId
LEFT JOIN (
    SELECT a.RoomId, n.StayDate, n.ReservationId
    FROM juyo.ReservationNight AS n
    INNER JOIN juyo.ReservationRoomAssignment AS a
        ON a.ReservationId = n.ReservationId
) AS n ON n.RoomId = s.RoomId AND n.StayDate = s.StayDate;
GO

CREATE VIEW juyo.CurrentRooms
AS
SELECT
    r.RoomId,
    rt.HotelId,
    r.RoomTypeId,
    r.[Number],
    r.Floor,
    s.OccupancyCode,
    s.HousekeepingCode,
    s.MaintenanceCode,
    s.MaintenanceNote,
    s.StayDate,
    s.BasisCode
FROM juyo.Room AS r
INNER JOIN juyo.RoomType AS rt ON rt.RoomTypeId = r.RoomTypeId
INNER JOIN juyo.Hotel AS h ON h.HotelId = rt.HotelId
INNER JOIN juyo.CurrentSourceImport AS i ON i.OrganizationId = h.OrganizationId
INNER JOIN juyo.RoomDailyStates AS s
    ON s.RoomId = r.RoomId AND s.StayDate = i.AsOfDate;
GO

CREATE VIEW juyo.DailyChannels
AS
WITH AcceptedByChannel AS (
    SELECT
        rt.HotelId,
        n.StayDate,
        r.ChannelCode,
        COUNT(*) AS SoldNights,
        SUM(n.RoomRevenue) AS GrossRevenue
    FROM juyo.ReservationNight AS n
    INNER JOIN juyo.ReservationRoomAssignment AS a
        ON a.ReservationId = n.ReservationId
    INNER JOIN juyo.Reservation AS r ON r.ReservationId = a.ReservationId
    INNER JOIN juyo.RoomType AS rt ON rt.RoomTypeId = r.RoomTypeId
    GROUP BY rt.HotelId, n.StayDate, r.ChannelCode
)
SELECT
    h.HotelId,
    d.StayDate,
    c.Code AS ChannelCode,
    COALESCE(n.SoldNights, 0) AS SoldNights,
    CAST(COALESCE(n.GrossRevenue, 0) AS decimal(19,2)) AS GrossRevenue,
    c.CommissionRate,
    -- Rounding belongs to hotel/date/channel, before any monthly aggregation.
    CAST(ROUND(COALESCE(n.GrossRevenue, 0) * c.CommissionRate, 2)
        AS decimal(19,2)) AS AcquisitionCost,
    CAST(CASE WHEN d.StayDate < d.AsOfDate THEN 'actual' ELSE 'on_books' END
        AS varchar(32)) AS BasisCode
FROM juyo.Hotel AS h
INNER JOIN juyo.ReportingDates AS d ON d.OrganizationId = h.OrganizationId
CROSS JOIN juyo.BookingChannel AS c
LEFT JOIN AcceptedByChannel AS n
    ON n.HotelId = h.HotelId AND n.StayDate = d.StayDate AND n.ChannelCode = c.Code;
GO

CREATE VIEW juyo.MonthlyChannels
AS
SELECT
    HotelId,
    CONVERT(char(7), StayDate, 126) AS PeriodKey,
    BasisCode,
    ChannelCode,
    SUM(SoldNights) AS SoldNights,
    CAST(SUM(GrossRevenue) AS decimal(19,2)) AS GrossRevenue,
    CommissionRate,
    CAST(SUM(AcquisitionCost) AS decimal(19,2)) AS AcquisitionCost
FROM juyo.DailyChannels
GROUP BY HotelId, CONVERT(char(7), StayDate, 126), BasisCode, ChannelCode, CommissionRate;
GO

CREATE VIEW juyo.MonthlyCosts
AS
SELECT
    c.HotelId,
    CONVERT(char(7), c.StayDate, 126) AS PeriodKey,
    c.BasisCode,
    a.CategoryCode,
    a.DepartmentCode,
    CAST(SUM(c.Amount) AS decimal(19,2)) AS Amount,
    a.Description
FROM juyo.DailyCost AS c
INNER JOIN juyo.CostAccount AS a ON a.CostAccountId = c.CostAccountId
GROUP BY c.HotelId, CONVERT(char(7), c.StayDate, 126),
    c.BasisCode, a.CategoryCode, a.DepartmentCode, a.Description;
GO

CREATE VIEW juyo.DailyPerformance
AS
WITH Capacity AS (
    SELECT
        rt.HotelId,
        s.StayDate,
        SUM(CASE WHEN s.IsOutOfService = 0 THEN 1 ELSE 0 END) AS RoomsAvailable
    FROM juyo.RoomDailyState AS s
    INNER JOIN juyo.Room AS r ON r.RoomId = s.RoomId
    INNER JOIN juyo.RoomType AS rt ON rt.RoomTypeId = r.RoomTypeId
    GROUP BY rt.HotelId, s.StayDate
), AcceptedNights AS (
    SELECT
        rt.HotelId,
        n.StayDate,
        COUNT(*) AS SoldNights,
        SUM(n.RoomRevenue) AS RoomRevenue
    FROM juyo.ReservationNight AS n
    INNER JOIN juyo.ReservationRoomAssignment AS a
        ON a.ReservationId = n.ReservationId
    INNER JOIN juyo.Reservation AS r ON r.ReservationId = a.ReservationId
    INNER JOIN juyo.RoomType AS rt ON rt.RoomTypeId = r.RoomTypeId
    GROUP BY rt.HotelId, n.StayDate
), FacilityActivity AS (
    SELECT
        f.HotelId,
        a.StayDate,
        SUM(CASE WHEN restaurant.FacilityId IS NOT NULL THEN a.Revenue ELSE 0 END)
            AS RestaurantRevenue,
        SUM(CASE WHEN restaurant.FacilityId IS NOT NULL THEN a.Uses ELSE 0 END)
            AS RestaurantCovers,
        SUM(CASE WHEN restaurant.FacilityId IS NULL THEN a.Revenue ELSE 0 END)
            AS OtherRevenue
    FROM juyo.FacilityDailyActivity AS a
    INNER JOIN juyo.Facility AS f ON f.FacilityId = a.FacilityId
    LEFT JOIN juyo.Restaurant AS restaurant ON restaurant.FacilityId = f.FacilityId
    GROUP BY f.HotelId, a.StayDate
)
SELECT
    h.HotelId,
    d.StayDate,
    COALESCE(c.RoomsAvailable, 0) AS RoomsAvailable,
    COALESCE(n.SoldNights, 0) AS SoldNights,
    CAST(COALESCE(n.RoomRevenue, 0) AS decimal(19,2)) AS RoomRevenue,
    CAST(COALESCE(a.RestaurantRevenue, 0) AS decimal(19,2)) AS RestaurantRevenue,
    COALESCE(a.RestaurantCovers, 0) AS RestaurantCovers,
    CAST(COALESCE(a.OtherRevenue, 0) AS decimal(19,2)) AS OtherRevenue,
    t.TargetRooms AS BudgetSoldNights,
    t.TargetRevenue AS BudgetRoomRevenue,
    CAST(CASE WHEN d.StayDate < d.AsOfDate THEN 'actual' ELSE 'on_books' END
        AS varchar(32)) AS BasisCode,
    CAST(CASE WHEN d.StayDate < d.AsOfDate THEN 'actual' ELSE 'planned' END
        AS varchar(32)) AS AncillaryBasisCode
FROM juyo.Hotel AS h
INNER JOIN juyo.ReportingDates AS d ON d.OrganizationId = h.OrganizationId
LEFT JOIN Capacity AS c ON c.HotelId = h.HotelId AND c.StayDate = d.StayDate
LEFT JOIN AcceptedNights AS n ON n.HotelId = h.HotelId AND n.StayDate = d.StayDate
LEFT JOIN FacilityActivity AS a ON a.HotelId = h.HotelId AND a.StayDate = d.StayDate
LEFT JOIN juyo.HotelDailyTarget AS t ON t.HotelId = h.HotelId AND t.StayDate = d.StayDate;
GO

CREATE VIEW juyo.BookingPositions
AS
SELECT
    currentPosition.HotelId,
    currentPosition.StayDate,
    currentPosition.CapturedAsOf,
    CAST(CASE
        WHEN currentPosition.StayDate < i.AsOfDate THEN 'past'
        WHEN currentPosition.StayDate = i.AsOfDate THEN 'today'
        ELSE 'future'
    END AS varchar(32)) AS StateCode,
    currentPosition.RoomsAvailable,
    CASE WHEN currentPosition.StayDate < i.AsOfDate THEN currentPosition.RoomCount END
        AS ActualRooms,
    CASE WHEN currentPosition.StayDate < i.AsOfDate THEN currentPosition.RoomRevenue END
        AS ActualRoomRevenue,
    CASE WHEN currentPosition.StayDate >= i.AsOfDate THEN currentPosition.RoomCount END
        AS RoomsOnBooks,
    CASE WHEN currentPosition.StayDate >= i.AsOfDate THEN currentPosition.RoomRevenue END
        AS RevenueOnBooks,
    CASE WHEN currentPosition.StayDate >= i.AsOfDate THEN previousPosition.RoomCount END
        AS RoomsOnBooks7dAgo,
    CASE WHEN currentPosition.StayDate >= i.AsOfDate THEN previousPosition.RoomRevenue END
        AS RevenueOnBooks7dAgo,
    CASE WHEN currentPosition.StayDate >= i.AsOfDate
        THEN currentPosition.RoomCount - previousPosition.RoomCount END AS Pickup7dRoomNights,
    CAST(CASE WHEN currentPosition.StayDate >= i.AsOfDate
        THEN currentPosition.RoomRevenue - previousPosition.RoomRevenue END
        AS decimal(19,2)) AS Pickup7dRevenue,
    t.TargetRooms,
    t.TargetRevenue
FROM juyo.BookingPositionSnapshot AS currentPosition
INNER JOIN juyo.Hotel AS h ON h.HotelId = currentPosition.HotelId
INNER JOIN juyo.CurrentSourceImport AS i
    ON i.OrganizationId = h.OrganizationId AND currentPosition.CapturedAsOf = i.AsOfDate
LEFT JOIN juyo.BookingPositionSnapshot AS previousPosition
    ON previousPosition.HotelId = currentPosition.HotelId
    AND previousPosition.StayDate = currentPosition.StayDate
    AND previousPosition.CapturedAsOf = i.PreviousAsOfDate
LEFT JOIN juyo.HotelDailyTarget AS t
    ON t.HotelId = currentPosition.HotelId AND t.StayDate = currentPosition.StayDate
WHERE currentPosition.StayDate BETWEEN i.PeriodStartDate AND i.PeriodEndDate;
GO

CREATE VIEW juyo.HotelDailyFinancialSummary
AS
WITH DailyExpense AS (
    SELECT HotelId, StayDate, SUM(Amount) AS OperatingCosts
    FROM juyo.DailyCost
    GROUP BY HotelId, StayDate
)
SELECT
    p.HotelId,
    p.StayDate,
    p.RoomRevenue,
    p.BasisCode AS RoomRevenueBasisCode,
    CAST(p.RestaurantRevenue + p.OtherRevenue AS decimal(19,2)) AS AncillaryRevenue,
    p.AncillaryBasisCode,
    CAST(COALESCE(c.OperatingCosts, 0) AS decimal(19,2)) AS OperatingCosts,
    p.AncillaryBasisCode AS CostBasisCode,
    -- Channel acquisition expense already belongs to DailyCost; never subtract twice.
    CAST(CASE WHEN p.BasisCode = 'actual'
        THEN p.RoomRevenue + p.RestaurantRevenue + p.OtherRevenue
            - COALESCE(c.OperatingCosts, 0)
        END AS decimal(19,2)) AS ActualOperatingProfit
FROM juyo.DailyPerformance AS p
LEFT JOIN DailyExpense AS c ON c.HotelId = p.HotelId AND c.StayDate = p.StayDate;
GO

CREATE VIEW juyo.HotelMonthlyFinancialSummary
AS
SELECT
    HotelId,
    CONVERT(char(7), StayDate, 126) AS PeriodKey,
    SUM(CASE WHEN RoomRevenueBasisCode = 'actual' THEN 1 ELSE 0 END) AS ActualDays,
    CAST(SUM(CASE WHEN RoomRevenueBasisCode = 'actual' THEN RoomRevenue END)
        AS decimal(19,2)) AS ActualRoomRevenue,
    CAST(SUM(CASE WHEN AncillaryBasisCode = 'actual' THEN AncillaryRevenue END)
        AS decimal(19,2)) AS ActualAncillaryRevenue,
    CAST(SUM(CASE WHEN CostBasisCode = 'actual' THEN OperatingCosts END)
        AS decimal(19,2)) AS ActualOperatingCosts,
    CAST(SUM(ActualOperatingProfit) AS decimal(19,2)) AS ActualOperatingProfit,
    CAST(SUM(CASE WHEN RoomRevenueBasisCode = 'on_books' THEN RoomRevenue END)
        AS decimal(19,2)) AS OnBooksRoomRevenue,
    CAST(SUM(CASE WHEN AncillaryBasisCode = 'planned' THEN AncillaryRevenue END)
        AS decimal(19,2)) AS PlannedAncillaryRevenue,
    CAST(SUM(CASE WHEN CostBasisCode = 'planned' THEN OperatingCosts END)
        AS decimal(19,2)) AS PlannedOperatingCosts
FROM juyo.HotelDailyFinancialSummary
GROUP BY HotelId, CONVERT(char(7), StayDate, 126);
GO
