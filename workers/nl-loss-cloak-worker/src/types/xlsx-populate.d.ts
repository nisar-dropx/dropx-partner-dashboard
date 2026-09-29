declare module 'xlsx-populate' {
  interface Range {
    value(): unknown[][];
  }
  interface Sheet {
    name(): string;
    usedRange(): Range | undefined;
  }
  interface Workbook {
    outputAsync(opts?: { type?: string; password?: string }): Promise<ArrayBuffer | Uint8Array | Blob | Buffer>;
    sheets(): Sheet[];
  }
  interface XlsxPopulateStatic {
    fromDataAsync(
      data: ArrayBuffer | Uint8Array | Buffer,
      opts?: { password?: string },
    ): Promise<Workbook>;
  }
  const XlsxPopulate: XlsxPopulateStatic;
  export default XlsxPopulate;
}
