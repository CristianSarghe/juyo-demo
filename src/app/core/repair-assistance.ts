export interface RepairHelpItem {
  hotelId: string;
  hotelName: string;
  city: string;
  country: string;
  roomNumber: string;
  issue: string;
}

/** Builds an editable UI draft from the information already visible in room management. */
export function repairHelpPrompt(items: readonly RepairHelpItem[]): string {
  const clean = (value: string, max = 100) => value.replace(/\s+/g, ' ').trim().slice(0, max);
  const roomLines = items.map(
    (item) =>
      `- ${clean(item.hotelName)} (hotel ID: ${clean(item.hotelId, 64)}), ${clean(item.city)}, ${clean(item.country)}. Room ${clean(item.roomNumber, 20)}: ${clean(item.issue, 240) || 'Maintenance issue needs clarification.'}`,
  );
  // Keep the verification instructions intact within the composer's 4,000-character limit.
  const rooms: string[] = [];
  let length = 0;
  for (const line of roomLines) {
    if (length + line.length > 2600) break;
    rooms.push(line);
    length += line.length + 1;
  }
  if (rooms.length < items.length)
    rooms.push(
      `- ${items.length - rooms.length} additional affected rooms; ask me for their details if needed.`,
    );
  return [
    'Find local technical repair companies that can resolve the following hotel-room maintenance issues:',
    '',
    ...(rooms.length
      ? rooms
      : ['Ask me for the hotel location, affected rooms and maintenance issue first.']),
    '',
    'Retrieve the hotel address and current maintenance details from the backend before searching. If the fault is too vague to choose a trade, ask me one short question first.',
    'Suggest a short list near each hotel. Include the relevant trade, service area, public business phone number and whether urgent hotel call-outs are available.',
    'Link the source for each company and contact detail. State what has been verified and what still needs confirmation. Do not invent companies, phone numbers or availability.',
  ].join('\n');
}
