-- Standalone post-import integrity probes. Run only after the import commits.
-- Each mutation is rolled back; this file must not run inside another transaction.
-- sqlcmd -b exits on an unexpected rejection, acceptance, or cleanup failure.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
SET XACT_ABORT ON;
SET NOCOUNT ON;
IF @@TRANCOUNT <> 0
    THROW 51989, 'Constraint probes require a standalone connection with no outer transaction.', 1;
GO

-- orphan room type hotel FK
BEGIN TRY
    BEGIN TRANSACTION;
INSERT INTO juyo.RoomType
        (RoomTypeId, HotelId, Name, MaxAdults, MaxChildren, AreaM2, BaseRate)
    VALUES
        ('__probe_orphan_type', '__probe_missing_hotel', N'Constraint probe', 1, 0, 20.00, 100.00);
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: orphan room type hotel FK.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (547) OR CHARINDEX(N'FK_RoomType_Hotel', @ErrorMessage) = 0
        THROW;
    PRINT N'PASS: orphan room type hotel FK';
END CATCH;
GO

-- negative nightly selling rate CHECK
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @TypeId varchar(64), @StayDate date;
    SELECT TOP (1) @TypeId = RoomTypeId, @StayDate = StayDate
    FROM juyo.RoomDailyRate ORDER BY RoomTypeId, StayDate;
    IF @TypeId IS NULL THROW 51991, 'No selling rate is available for the probe.', 1;
    UPDATE juyo.RoomDailyRate SET NightlyRate = -0.01
    WHERE RoomTypeId = @TypeId AND StayDate = @StayDate;
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: negative nightly selling rate CHECK.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (547) OR CHARINDEX(N'CK_RoomDailyRate_Amount', @ErrorMessage) = 0
        THROW;
    PRINT N'PASS: negative nightly selling rate CHECK';
END CATCH;
GO

-- hotel room number uniqueness across room types
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @OtherTypeId varchar(64), @RoomNumber varchar(16), @Floor smallint;
    SELECT TOP (1) @OtherTypeId = otherType.RoomTypeId, @RoomNumber = room.[Number], @Floor = room.Floor
    FROM juyo.Room AS room
    INNER JOIN juyo.RoomType AS originalType ON originalType.RoomTypeId = room.RoomTypeId
    INNER JOIN juyo.RoomType AS otherType
        ON otherType.HotelId = originalType.HotelId AND otherType.RoomTypeId <> originalType.RoomTypeId
    ORDER BY room.RoomId, otherType.RoomTypeId;
    IF @OtherTypeId IS NULL THROW 51992, 'No same-hotel alternative room type is available for the probe.', 1;
    INSERT INTO juyo.Room (RoomId, RoomTypeId, [Number], Floor)
    VALUES ('__probe_duplicate_room', @OtherTypeId, @RoomNumber, @Floor);
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: hotel room number uniqueness across room types.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (2601, 2627) OR CHARINDEX(N'UX_RoomNumberScope_HotelNumber', @ErrorMessage) = 0
        THROW;
    PRINT N'PASS: hotel room number uniqueness across room types';
END CATCH;
GO

-- cross-type room assignment trigger
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @ReservationId varchar(64), @OtherRoomId varchar(64);
    -- A cancelled assignment has no nights, so no allocation index can preempt the intended trigger.
    SELECT TOP (1) @ReservationId = reservation.ReservationId, @OtherRoomId = otherRoom.RoomId
    FROM juyo.Reservation AS reservation
    INNER JOIN juyo.ReservationRoomAssignment AS assignment
        ON assignment.ReservationId = reservation.ReservationId
    INNER JOIN juyo.RoomType AS requested ON requested.RoomTypeId = reservation.RoomTypeId
    INNER JOIN juyo.RoomType AS otherType
        ON otherType.HotelId = requested.HotelId AND otherType.RoomTypeId <> requested.RoomTypeId
    INNER JOIN juyo.Room AS otherRoom ON otherRoom.RoomTypeId = otherType.RoomTypeId
    WHERE reservation.StatusCode = 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM juyo.ReservationNight AS night WHERE night.ReservationId = reservation.ReservationId)
    ORDER BY reservation.ReservationId, otherRoom.RoomId;
    IF @ReservationId IS NULL THROW 51993, 'No cancelled assignment is available for the probe.', 1;
    UPDATE juyo.ReservationRoomAssignment SET RoomId = @OtherRoomId
    WHERE ReservationId = @ReservationId;
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: cross-type room assignment trigger.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (51004) OR CHARINDEX(N'Assigned room must belong to the reservation room type.', @ErrorMessage) = 0 OR COALESCE(ERROR_PROCEDURE(), N'') NOT LIKE N'%TR_ReservationRoomAssignment_Validate'
        THROW;
    PRINT N'PASS: cross-type room assignment trigger';
END CATCH;
GO

-- accepted room night allocation uniqueness
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @OriginalReservationId varchar(64), @RoomId varchar(64), @StayDate date, @Revenue decimal(19,2);
    SELECT TOP (1)
        @OriginalReservationId = night.ReservationId,
        @RoomId = assignment.RoomId,
        @StayDate = night.StayDate,
        @Revenue = night.RoomRevenue
    FROM juyo.ReservationNight AS night
    INNER JOIN juyo.ReservationRoomAssignment AS assignment ON assignment.ReservationId = night.ReservationId
    ORDER BY night.ReservationId, night.StayDate;
    IF @OriginalReservationId IS NULL THROW 51994, 'No accepted room night is available for the probe.', 1;
    IF EXISTS (SELECT 1 FROM juyo.Reservation WHERE ReservationId = '__probe_reservation')
        THROW 51995, 'Reserved probe identifier already exists.', 1;
    INSERT INTO juyo.Reservation
        (ReservationId, RoomTypeId, GuestReference, ChannelCode, StatusCode, ArrivalDate, DepartureDate,
         Adults, Children, BookedOn, CancelledOn, QuotedNightlyRate)
    SELECT '__probe_reservation', RoomTypeId, GuestReference, ChannelCode, StatusCode, ArrivalDate,
           DepartureDate, Adults, Children, BookedOn, CancelledOn, QuotedNightlyRate
    FROM juyo.Reservation WHERE ReservationId = @OriginalReservationId;
    INSERT INTO juyo.ReservationRoomAssignment (ReservationId, RoomId)
    VALUES ('__probe_reservation', @RoomId);
    INSERT INTO juyo.ReservationNight (ReservationId, StayDate, RoomRevenue)
    VALUES ('__probe_reservation', @StayDate, @Revenue);
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: accepted room night allocation uniqueness.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (2601, 2627) OR CHARINDEX(N'UX_RoomNightAllocation_RoomDate', @ErrorMessage) = 0
        THROW;
    PRINT N'PASS: accepted room night allocation uniqueness';
END CATCH;
GO

-- cancellation cannot retain accepted nights
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @ReservationId varchar(64);
    SELECT TOP (1) @ReservationId = reservation.ReservationId
    FROM juyo.Reservation AS reservation
    WHERE reservation.StatusCode IN ('confirmed', 'checked_in', 'checked_out')
        AND EXISTS (SELECT 1 FROM juyo.ReservationNight AS night WHERE night.ReservationId = reservation.ReservationId)
    ORDER BY reservation.ReservationId;
    IF @ReservationId IS NULL THROW 51996, 'No accepted reservation is available for the probe.', 1;
    UPDATE juyo.Reservation SET StatusCode = 'cancelled', CancelledOn = BookedOn
    WHERE ReservationId = @ReservationId;
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: cancellation cannot retain accepted nights.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (51003) OR CHARINDEX(N'Accepted nights require an accepted reservation and dates inside its stay.', @ErrorMessage) = 0 OR COALESCE(ERROR_PROCEDURE(), N'') NOT LIKE N'%TR_Reservation_Validate'
        THROW;
    PRINT N'PASS: cancellation cannot retain accepted nights';
END CATCH;
GO

-- accepted room cannot be taken out of service
BEGIN TRY
    BEGIN TRANSACTION;
DECLARE @RoomId varchar(64), @StayDate date;
    SELECT TOP (1) @RoomId = allocation.RoomId, @StayDate = allocation.StayDate
    FROM juyo.RoomNightAllocation AS allocation
    INNER JOIN juyo.RoomDailyState AS state ON state.RoomId = allocation.RoomId AND state.StayDate = allocation.StayDate
    WHERE state.IsOutOfService = 0
    ORDER BY allocation.RoomId, allocation.StayDate;
    IF @RoomId IS NULL THROW 51997, 'No accepted in-service room date is available for the probe.', 1;
    UPDATE juyo.RoomDailyState SET IsOutOfService = 1
    WHERE RoomId = @RoomId AND StayDate = @StayDate;
    ROLLBACK TRANSACTION;
    THROW 51990, 'Expected rejection did not occur: accepted room cannot be taken out of service.', 1;
END TRY
BEGIN CATCH
    DECLARE @ErrorNumber int = ERROR_NUMBER();
    DECLARE @ErrorMessage nvarchar(4000) = ERROR_MESSAGE();
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    IF @ErrorNumber NOT IN (51010) OR CHARINDEX(N'Room-state changes cannot invalidate accepted room nights.', @ErrorMessage) = 0 OR COALESCE(ERROR_PROCEDURE(), N'') NOT LIKE N'%TR_RoomDailyState_ValidateAcceptedNights'
        THROW;
    PRINT N'PASS: accepted room cannot be taken out of service';
END CATCH;
GO

-- Positive checks: housekeeping and minor maintenance do not imply unavailable inventory.
BEGIN TRY
    BEGIN TRANSACTION;
    DECLARE @RoomId varchar(64), @StayDate date;
    SELECT TOP (1) @RoomId = allocation.RoomId, @StayDate = allocation.StayDate
    FROM juyo.RoomNightAllocation AS allocation
    INNER JOIN juyo.RoomDailyState AS state ON state.RoomId = allocation.RoomId AND state.StayDate = allocation.StayDate
    WHERE state.IsOutOfService = 0
    ORDER BY allocation.RoomId, allocation.StayDate;
    IF @RoomId IS NULL THROW 51998, 'No accepted in-service room date is available for positive probes.', 1;
    UPDATE juyo.RoomDailyState SET HousekeepingCode = 'inspected'
    WHERE RoomId = @RoomId AND StayDate = @StayDate;
    UPDATE juyo.RoomDailyState
    SET MaintenanceCode = 'reported', MaintenanceNote = N'Temporary constraint probe: minor repair', IsOutOfService = 0
    WHERE RoomId = @RoomId AND StayDate = @StayDate;
    IF NOT EXISTS (
        SELECT 1 FROM juyo.RoomDailyState
        WHERE RoomId = @RoomId AND StayDate = @StayDate
            AND HousekeepingCode = 'inspected' AND MaintenanceCode = 'reported' AND IsOutOfService = 0
    )
        THROW 51999, 'Positive room-state probes did not apply.', 1;
    ROLLBACK TRANSACTION;
    PRINT N'PASS: inspected housekeeping is allowed on an accepted room date';
    PRINT N'PASS: reported minor maintenance can remain in service';
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
GO

IF @@TRANCOUNT <> 0
    THROW 52000, 'Constraint probes left an open transaction.', 1;
IF EXISTS (SELECT 1 FROM juyo.Room WHERE RoomId = '__probe_duplicate_room')
    OR EXISTS (SELECT 1 FROM juyo.RoomType WHERE RoomTypeId = '__probe_orphan_type')
    OR EXISTS (SELECT 1 FROM juyo.Reservation WHERE ReservationId = '__probe_reservation')
    THROW 52001, 'Constraint probes left a persistent probe row.', 1;
PRINT N'PASS: all probes rolled back; no probe rows remain';
GO
