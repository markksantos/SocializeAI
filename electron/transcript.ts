export type TranscriptMessage = {
  at: string;
  sender: string;
  text: string;
  fromMe: boolean;
};

const transcriptHeaderPattern = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?):\s*(.*)$/;

function appendLine(message: TranscriptMessage, line: string) {
  message.text = message.text ? `${message.text}\n${line}` : line;
}

export function parseTranscriptMessages(transcript: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];

  transcript.split("\n").forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const match = line.match(transcriptHeaderPattern);

    if (match) {
      const sender = match[2].trim();
      messages.push({
        at: match[1],
        sender,
        text: match[3].trim() || "[No text content]",
        fromMe: sender.toLowerCase() === "me"
      });
      return;
    }

    const previous = messages[messages.length - 1];
    if (previous) appendLine(previous, line);
  });

  return messages.map((message) => ({
    ...message,
    text: message.text.trim() || "[No text content]"
  }));
}

export function formatTranscriptMessage(message: TranscriptMessage) {
  return `${message.at} ${message.sender}: ${message.text}`;
}

export function latestInboundLine(messages: string) {
  const inbound = [...parseTranscriptMessages(messages)].reverse().find((message) => !message.fromMe);
  return inbound ? formatTranscriptMessage(inbound) : undefined;
}
