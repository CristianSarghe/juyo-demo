import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sql from 'mssql';
import { readEnvironment } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { SqlNetworkRepository } from '../src/data/sql-network.repository.js';
import { SqlWorkspaceRepository } from '../src/persistence/sql-workspace.repository.js';
import { RepositoryError } from '../src/persistence/repository-error.js';
import { createNetworkSelectors } from '../src/domain/network.selectors.js';
import type { Message } from '../src/domain/models.js';
import { createChatAnswers } from '../src/chat/reply.js';
import { rateVersion, type RateUpdateReviewItem } from '../src/domain/rate-batch.js';
import type { RoomRateUpdateRequest } from '../src/domain/mutation.models.js';

const enabled = process.env.SQL_INTEGRATION === '1';
const isProblem = (status: number) => (error: unknown) =>
  error instanceof RepositoryError && error.status === status;
const pair = (question: string): Message[] => [
  { id: randomUUID(), role: 'user', content: question, createdAt: new Date().toISOString() },
  {
    id: randomUUID(),
    role: 'assistant',
    content: 'Analytics response.',
    createdAt: new Date().toISOString(),
  },
];

test(
  'SQL workspace preserves canonical facts, isolation, atomic writes and bounded chat',
  {
    skip: !enabled,
    timeout: 180_000,
  },
  async () => {
    const database = createDatabase(readEnvironment());
    const pool = await database.connect();
    const workspace = new SqlWorkspaceRepository(pool);
    const run = randomUUID();
    const emailA = `integration-a-${run}@example.invalid`;
    const emailB = `integration-b-${run}@example.invalid`;
    let userA: string | undefined;
    let userB: string | undefined;
    let changedRoomId: string | undefined;
    try {
      const canonical = await new SqlNetworkRepository(pool).load();
      const asOf = canonical.bookingSnapshot.asOf;
      const month = canonical.reportingPeriods.find(
        (row) => row.startDate <= asOf && row.endDate >= asOf,
      )!;
      await pool
        .request()
        .input('idA', sql.UniqueIdentifier, randomUUID())
        .input('idB', sql.UniqueIdentifier, randomUUID())
        .input('emailA', sql.NVarChar(254), emailA)
        .input('emailB', sql.NVarChar(254), emailB).query(`
          INSERT INTO juyo_api.ApiUser(Id,Email,Name,PasswordHash)
          VALUES(@idA,@emailA,N'Integration account A',NULL),(@idB,@emailB,N'Integration account B',NULL);`);
      const users = await pool
        .request()
        .input('a', sql.NVarChar(254), emailA)
        .input('b', sql.NVarChar(254), emailB)
        .query('SELECT Id AS id,Email AS email FROM juyo_api.ApiUser WHERE Email IN (@a,@b);');
      userA = String(users.recordset.find((row) => row.email === emailA)!.id);
      userB = String(users.recordset.find((row) => row.email === emailB)!.id);
      const selectors = createNetworkSelectors(canonical);
      const initial = await workspace.listRoomChanges();
      const inventory = selectors.hotelInventory('portfolio', asOf);
      const free = [...inventory]
        .reverse()
        .find(
          (room) =>
            room.occupancy === 'available' && !initial.some((change) => change.roomId === room.id),
        );
      const occupied = inventory.find((room) => room.occupancy === 'occupied');
      assert(free && occupied, 'The imported calendar must contain a free and an occupied room.');
      changedRoomId = free.id;
      const housekeeping = free.housekeeping === 'dirty' ? 'clean' : 'dirty';
      await Promise.all([
        workspace.applyRoomAction(free.id, housekeeping, userA),
        workspace.applyRoomAction(free.id, 'reserve', userB),
      ]);
      const combined = (await workspace.listRoomChanges()).find(
        (change) => change.roomId === free.id,
      );
      assert.equal(
        combined?.housekeeping,
        housekeeping,
        'Concurrent actions preserve housekeeping.',
      );
      assert.equal(combined?.status, 'reserved', 'Concurrent actions preserve the manual hold.');
      await assert.rejects(
        workspace.applyRoomAction(occupied.id, 'available', userA),
        isProblem(409),
      );
      await workspace.applyRoomAction(free.id, 'out_of_service', userA);
      await assert.rejects(workspace.applyRoomAction(free.id, 'reserve', userA), isProblem(409));
      await workspace.applyRoomAction(free.id, 'reset', userA);
      assert(!(await workspace.listRoomChanges()).some((change) => change.roomId === free.id));
      await assert.rejects(
        workspace.setRoomChange(
          {
            roomId: free.id,
            date: month.startDate,
            appliedAt: new Date().toISOString(),
            status: 'reserved',
          },
          userA,
        ),
        isProblem(409),
      );

      const type = canonical.roomTypes.find((row) => row.hotelId === free.hotelId)!;
      const rateA = await workspace.createRateUpdate(
        {
          hotelId: type.hotelId,
          roomTypeId: type.id,
          startDate: asOf,
          endDate: asOf,
          nightlyRate: 199.35,
          reason: 'Integration persistence check',
        },
        userA,
      );
      const rateB = await workspace.createRateUpdate(
        {
          hotelId: type.hotelId,
          roomTypeId: type.id,
          startDate: asOf,
          endDate: asOf,
          nightlyRate: 209.55,
        },
        userB,
      );
      assert.deepEqual(await workspace.getRateUpdate(rateA.id), rateA);
      const updates = await workspace.listRateUpdates();
      assert(
        updates.findIndex((row) => row.id === rateB.id) >
          updates.findIndex((row) => row.id === rateA.id),
        'Overlapping updates retain application order.',
      );
      await assert.rejects(
        workspace.createRateUpdate(
          {
            hotelId: type.hotelId,
            roomTypeId: type.id,
            startDate: asOf,
            endDate: asOf,
            nightlyRate: 1.001,
          },
          userA,
        ),
        isProblem(422),
      );

      const context = {
        title: 'Persistence check',
        propertyId: type.hotelId,
        month: month.key,
        roomDate: asOf,
      };
      const conversationA = await workspace.createConversation(userA, context);
      const conversationB = await workspace.createConversation(userB, context);
      assert.equal(await workspace.getConversation(userB, conversationA.id), null);
      assert.equal(await workspace.deleteConversation(userB, conversationA.id), false);
      await assert.rejects(
        workspace.appendMessages(userB, conversationA.id, pair('Not my conversation')),
        isProblem(404),
      );
      const messages = pair('What is the room revenue?');
      const reply = createChatAnswers(canonical);
      const hotel = canonical.hotels.find((row) => row.id === type.hotelId)!;
      const answer = reply(
        messages[0].content,
        { id: hotel.id, name: hotel.name, location: hotel.city },
        month.key,
        asOf,
      );
      messages[1] = { ...messages[1], ...answer };
      const saved = await workspace.appendMessages(userA, conversationA.id, messages);
      assert.equal(saved.messages.length, 2);
      assert.deepEqual(
        saved.messages[1].insight,
        answer.insight,
        'Structured analytic answers round-trip as JSON.',
      );
      assert.equal(
        (await workspace.listConversations(userA)).some((row) => row.id === conversationB.id),
        false,
      );

      const actionMessages = pair('Please set the Classic rate to €195.');
      const actionId = randomUUID();
      actionMessages[1].action = {
        id: actionId,
        kind: 'rate_update',
        status: 'pending',
        summary: 'Set the nightly rate to €195.',
        details: {
          hotelId: type.hotelId,
          hotelName: hotel.name,
          roomTypeId: type.id,
          roomTypeName: type.name,
          startDate: asOf,
          endDate: asOf,
          nightlyRate: 195,
          reason: `Chat confirmation ${run}`,
        },
      };
      await workspace.appendMessages(userA, conversationA.id, actionMessages);
      await assert.rejects(
        workspace.confirmChatAction(userB, conversationA.id, actionId, 'apply'),
        isProblem(404),
      );
      const confirmed = await Promise.all([
        workspace.confirmChatAction(userA, conversationA.id, actionId, 'apply'),
        workspace.confirmChatAction(userA, conversationA.id, actionId, 'apply'),
      ]);
      assert(confirmed.every((row) => row.messages.at(-1)?.action?.status === 'applied'));
      assert.equal(
        (await workspace.listRateUpdates()).filter(
          (row) => row.reason === `Chat confirmation ${run}`,
        ).length,
        1,
        'Concurrent confirmation and retries apply one rate change only.',
      );
      await assert.rejects(
        workspace.confirmChatAction(userA, conversationA.id, actionId, 'cancel'),
        isProblem(409),
      );

      const cancelled = pair('Mark the room clean.');
      const cancelId = randomUUID();
      cancelled[1].action = {
        id: cancelId,
        kind: 'room_action',
        status: 'pending',
        summary: 'Mark this room clean.',
        details: {
          roomId: free.id,
          roomNumber: free.number,
          hotelName: hotel.name,
          action: 'clean',
          date: asOf,
        },
      };
      await workspace.appendMessages(userA, conversationA.id, cancelled);
      assert.equal(
        (
          await workspace.confirmChatAction(userA, conversationA.id, cancelId, 'cancel')
        ).messages.at(-1)?.action?.status,
        'cancelled',
      );
      await assert.rejects(
        workspace.confirmChatAction(userA, conversationA.id, cancelId, 'apply'),
        isProblem(409),
      );
      assert(!(await workspace.listRoomChanges()).some((row) => row.roomId === free.id));

      const blocked = pair('Free an occupied room.');
      const blockedId = randomUUID();
      blocked[1].action = {
        ...cancelled[1].action,
        id: blockedId,
        details: { ...cancelled[1].action.details, roomId: occupied.id, action: 'available' },
      };
      await workspace.appendMessages(userA, conversationA.id, blocked);
      await assert.rejects(
        workspace.confirmChatAction(userA, conversationA.id, blockedId, 'apply'),
        isProblem(409),
      );
      assert.equal(
        (await workspace.getConversation(userA, conversationA.id))!.messages.at(-1)?.action?.status,
        'pending',
        'A rejected room mutation rolls back the decision and leaves its proposal pending.',
      );

      const otherType = canonical.roomTypes.find((row) => row.hotelId !== type.hotelId)!;
      const nextDay = new Date(Date.parse(`${asOf}T12:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const followingDay = new Date(Date.parse(`${asOf}T12:00:00Z`) + 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const review = async (request: RoomRateUpdateRequest): Promise<RateUpdateReviewItem> => {
        const quotes = await new SqlNetworkRepository(pool).readCollection(
          'roomRates',
          new URLSearchParams({
            hotelId: request.hotelId,
            roomTypeId: request.roomTypeId,
            from: request.startDate,
            to: request.endDate,
            pageSize: '1000',
          }),
        );
        const roomType = canonical.roomTypes.find((row) => row.id === request.roomTypeId)!;
        return {
          ...request,
          hotelName: canonical.hotels.find((row) => row.id === request.hotelId)!.name,
          roomTypeName: roomType.name,
          currentMinRate: Math.min(...quotes.items.map((row) => row.nightlyRate)),
          currentMaxRate: Math.max(...quotes.items.map((row) => row.nightlyRate)),
          expectedRateVersion: rateVersion(quotes.items),
        };
      };
      const batchReason = `Batch confirmation ${run}`;
      const reviewedUpdates = await Promise.all([
        review({
          hotelId: type.hotelId,
          roomTypeId: type.id,
          startDate: nextDay,
          endDate: followingDay,
          nightlyRate: 214.35,
          reason: batchReason,
        }),
        review({
          hotelId: otherType.hotelId,
          roomTypeId: otherType.id,
          startDate: nextDay,
          endDate: nextDay,
          nightlyRate: 189.55,
          reason: batchReason,
        }),
      ]);
      const batchMessages = pair('Update these room types and dates together.');
      const batchId = randomUUID();
      batchMessages[1].action = {
        id: batchId,
        kind: 'rate_batch_update',
        status: 'pending',
        summary: 'Review two price changes.',
        details: { updates: reviewedUpdates },
      };
      await workspace.appendMessages(userA, conversationA.id, batchMessages);
      await assert.rejects(
        workspace.confirmChatAction(userB, conversationA.id, batchId, 'apply'),
        isProblem(404),
      );
      const batchConfirmed = await Promise.all([
        workspace.confirmChatAction(userA, conversationA.id, batchId, 'apply'),
        workspace.confirmChatAction(userA, conversationA.id, batchId, 'apply'),
      ]);
      assert(batchConfirmed.every((row) => row.messages.at(-1)?.action?.status === 'applied'));
      assert.equal(
        (await workspace.listRateUpdates()).filter((row) => row.reason === batchReason).length,
        2,
        'Concurrent confirmation applies the complete two-row batch exactly once.',
      );

      const staleReason = `Stale batch ${run}`;
      const staleUpdates = await Promise.all(
        reviewedUpdates.map((row) =>
          review({
            ...row,
            nightlyRate: row.nightlyRate + 1,
            reason: staleReason,
          }),
        ),
      );
      const staleMessages = pair('Prepare another batch for these dates.');
      const staleId = randomUUID();
      staleMessages[1].action = {
        id: staleId,
        kind: 'rate_batch_update',
        status: 'pending',
        summary: 'Review a batch before a concurrent manual edit.',
        details: { updates: staleUpdates },
      };
      await workspace.appendMessages(userA, conversationA.id, staleMessages);
      await workspace.createRateUpdate(
        { ...staleUpdates[1], nightlyRate: 190.55, reason: `Concurrent manual edit ${run}` },
        userB,
      );
      await assert.rejects(
        workspace.confirmChatAction(userA, conversationA.id, staleId, 'apply'),
        (error: unknown) =>
          error instanceof RepositoryError &&
          error.status === 409 &&
          error.code === 'STALE_RATE_PROPOSAL',
      );
      assert.equal(
        (await workspace.listRateUpdates()).filter((row) => row.reason === staleReason).length,
        0,
        'A stale later row prevents the valid first row from being applied.',
      );
      assert.equal(
        (await workspace.getConversation(userA, conversationA.id))!.messages.at(-1)?.action?.status,
        'pending',
        'A failed batch remains reviewable and never records an applied decision.',
      );
      await workspace.confirmChatAction(userA, conversationA.id, staleId, 'cancel');

      const invalidReason = `Invalid batch ${run}`;
      const invalidUpdates = await Promise.all(
        reviewedUpdates.map((row) =>
          review({
            ...row,
            nightlyRate: row.nightlyRate + 2,
            reason: invalidReason,
          }),
        ),
      );
      invalidUpdates[1] = { ...invalidUpdates[1], eventId: 'missing-event' };
      const invalidMessages = pair('Review a batch whose event was removed.');
      const invalidId = randomUUID();
      invalidMessages[1].action = {
        id: invalidId,
        kind: 'rate_batch_update',
        status: 'pending',
        summary: 'Review an event price batch.',
        details: { updates: invalidUpdates },
      };
      await workspace.appendMessages(userA, conversationA.id, invalidMessages);
      await assert.rejects(
        workspace.confirmChatAction(userA, conversationA.id, invalidId, 'apply'),
        isProblem(422),
      );
      assert.equal(
        (await workspace.listRateUpdates()).filter((row) => row.reason === invalidReason).length,
        0,
        'An invalid later row leaves every price and the decision unchanged.',
      );
      assert.equal(
        (await workspace.getConversation(userA, conversationA.id))!.messages.at(-1)?.action?.status,
        'pending',
      );

      // Establish a full 100-message history with a single bounded API-only setup statement.
      await pool.request().input('id', sql.UniqueIdentifier, conversationA.id).query(`
DECLARE @LastOrdinal int=(SELECT COALESCE(MAX(Ordinal),0) FROM juyo_api.Message WHERE ConversationId=@id);
DECLARE @Fill int=100-(SELECT COUNT(*) FROM juyo_api.Message WHERE ConversationId=@id);
WITH Numbers AS (SELECT TOP (@Fill) ROW_NUMBER() OVER (ORDER BY object_id) AS n FROM sys.all_objects)
INSERT juyo_api.Message(Id,ConversationId,Ordinal,RoleCode,Content,CreatedAt)
SELECT NEWID(),@id,n+@LastOrdinal,CASE WHEN n%2=1 THEN 'user' ELSE 'assistant' END,N'Retained history',SYSUTCDATETIME()
FROM Numbers;`);
      const beforeFailure = (await workspace.getConversation(userA, conversationA.id))!;
      const failedPair = pair('Roll back both messages');
      failedPair[1] = { ...failedPair[1], id: messages[1].id };
      await assert.rejects(workspace.appendMessages(userA, conversationA.id, failedPair));
      assert.deepEqual(
        (await workspace.getConversation(userA, conversationA.id))!.messages,
        beforeFailure.messages,
        'A failure inserting the assistant rolls back the preceding user message.',
      );
      const finalPair = pair('Keep the latest messages');
      const bounded = await workspace.appendMessages(userA, conversationA.id, finalPair);
      assert.equal(bounded.messages.length, 100);
      assert.equal(bounded.messages.at(-1)!.id, finalPair[1].id);
      assert(!bounded.messages.some((row) => row.id === messages[0].id));
      assert.equal(await workspace.deleteConversation(userA, conversationA.id), true);
      assert.equal(await workspace.getConversation(userA, conversationA.id), null);
      assert.deepEqual(
        await new SqlNetworkRepository(pool).load(),
        canonical,
        'Room/rate/chat API writes never mutate the canonical hotel ledger.',
      );
    } finally {
      // Dedicated test users own every temporary row; cleanup never touches juyo facts.
      try {
        if (changedRoomId && userA)
          await workspace.applyRoomAction(changedRoomId, 'reset', userA).catch(() => undefined);
        await pool
          .request()
          .input('emailA', sql.NVarChar(254), emailA)
          .input('emailB', sql.NVarChar(254), emailB).query(`
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @Owners TABLE(Id uniqueidentifier PRIMARY KEY);
INSERT @Owners SELECT Id FROM juyo_api.ApiUser WHERE Email IN (@emailA,@emailB);
DELETE FROM juyo_api.RoomOperationChange WHERE AppliedBy IN (SELECT Id FROM @Owners);
DELETE FROM juyo_api.RoomOperationAudit WHERE AppliedBy IN (SELECT Id FROM @Owners);
DELETE FROM juyo_api.RateUpdate WHERE AppliedBy IN (SELECT Id FROM @Owners);
DELETE m FROM juyo_api.Message m JOIN juyo_api.Conversation c ON c.Id=m.ConversationId WHERE c.UserId IN (SELECT Id FROM @Owners);
DELETE FROM juyo_api.Conversation WHERE UserId IN (SELECT Id FROM @Owners);
DELETE FROM juyo_api.ApiSession WHERE UserId IN (SELECT Id FROM @Owners);
DELETE FROM juyo_api.ApiUser WHERE Id IN (SELECT Id FROM @Owners);
COMMIT;`);
      } finally {
        await database.close();
      }
    }
  },
);
