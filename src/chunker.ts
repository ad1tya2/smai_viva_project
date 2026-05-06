export class TextChunker {
  private buffer = "";

  /**
   * Add text to the buffer and return any complete chunks.
   */
  add(text: string): string[] {
    this.buffer += text;
    const chunks: string[] = [];

    while (this.buffer.length > 0) {
      // Find a boundary
      let splitIndex = -1;

      // 1. Hard stop at 500 chars
      if (this.buffer.length >= 500) {
        // Try to find ANY space before 500 to avoid splitting a word
        const spaceIdx = this.buffer.lastIndexOf(" ", 500);
        splitIndex = spaceIdx > 0 ? spaceIdx : 500;
      } else {
        // 2. Look for sentence boundaries (. ! ?) that are followed by a space or end of string
        const match = this.buffer.match(/[.!?]+(\s|$)/);
        if (match && match.index !== undefined) {
          splitIndex = match.index + match[0].length;
        }
      }

      if (splitIndex > 0) {
        const chunk = this.buffer.substring(0, splitIndex).trim();
        this.buffer = this.buffer.substring(splitIndex).trimStart();
        if (chunk) {
          chunks.push(chunk);
        }
      } else {
        // No valid boundary found yet
        break;
      }
    }

    return chunks;
  }

  flush(): string[] {
    const chunks: string[] = [];
    if (this.buffer.trim().length > 0) {
      chunks.push(this.buffer.trim());
      this.buffer = "";
    }
    return chunks;
  }
}
