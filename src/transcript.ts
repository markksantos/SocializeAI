export type TranscriptMessage = {
  id: string;
  at: string;
  sender: string;
  text: string;
  fromMe: boolean;
};

const transcriptHeaderPattern = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?):\s*(.*)$/;

function appendLine(message: TranscriptMessage, line: string) {
  message.text = message.text ? `${message.text}\n${line}` : line;
}

export function chatBubblesFromTranscript(transcript: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];

  transcript.split("\n").forEach((rawLine, lineIndex) => {
    const line = rawLine.trimEnd();
    const match = line.match(transcriptHeaderPattern);

    if (match) {
      const sender = match[2].trim();
      messages.push({
        id: `${messages.length}-${match[1]}`,
        at: match[1],
        sender,
        text: match[3].trim() || "[No text content]",
        fromMe: sender.toLowerCase() === "me"
      });
      return;
    }

    const previous = messages[messages.length - 1];
    if (previous) {
      appendLine(previous, line);
      return;
    }

    if (line.trim()) {
      messages.push({
        id: `fallback-${lineIndex}-${line.slice(0, 24)}`,
        at: "",
        sender: "Message",
        text: line.trim(),
        fromMe: false
      });
    }
  });

  return messages.map((message) => ({
    ...message,
    text: message.text.trim() || "[No text content]"
  }));
}

export function formatTranscriptMessage(message: TranscriptMessage) {
  return message.at ? `${message.at} ${message.sender}: ${message.text}` : message.text;
}

export function latestInboundFromTranscript(transcript: string) {
  const inbound = [...chatBubblesFromTranscript(transcript)].reverse().find((message) => !message.fromMe);
  return inbound ? formatTranscriptMessage(inbound) : "";
}
