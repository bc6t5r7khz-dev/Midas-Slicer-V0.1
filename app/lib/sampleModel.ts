export function createSampleMct(): string {
  const records: string[] = ["; MCT Section Lab generated demo", "*NODE"];
  const nodeId = (ix: number, iy: number, iz: number) =>
    1001 + ix * 11 * 3 + iy * 3 + iz;

  for (let ix = 0; ix < 42; ix += 1) {
    const x = ix * 4;
    const crown = Math.sin((ix / 41) * Math.PI) * 7;
    for (let iy = -5; iy <= 5; iy += 1) {
      for (let iz = 0; iz < 3; iz += 1) {
        const edgeLift = Math.abs(iy) * 0.13;
        records.push(
          `${nodeId(ix, iy + 5, iz)}, ${x.toFixed(3)}, ${(iy * 1.8).toFixed(3)}, ${(crown + iz * 1.6 + edgeLift).toFixed(3)}`,
        );
      }
    }
  }

  records.push("*ELEMENT");
  let elementId = 1;
  for (let ix = 0; ix < 41; ix += 1) {
    for (let iy = 0; iy < 10; iy += 1) {
      for (let iz = 0; iz < 2; iz += 1) {
        records.push(
          `${elementId}, SOLID, 1, 1, ` +
            `${nodeId(ix, iy, iz)}, ${nodeId(ix + 1, iy, iz)}, ` +
            `${nodeId(ix + 1, iy + 1, iz)}, ${nodeId(ix, iy + 1, iz)}, ` +
            `${nodeId(ix, iy, iz + 1)}, ${nodeId(ix + 1, iy, iz + 1)}, ` +
            `${nodeId(ix + 1, iy + 1, iz + 1)}, ${nodeId(ix, iy + 1, iz + 1)}`,
        );
        elementId += 1;
      }
    }
  }
  return records.join("\n");
}
