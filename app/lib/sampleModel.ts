export function createSampleMct(): string {
  const records: string[] = ["; MCT Section Lab generated demo", "*NODE"];
  let id = 1001;

  for (let ix = 0; ix < 42; ix += 1) {
    const x = ix * 4;
    const crown = Math.sin((ix / 41) * Math.PI) * 7;
    for (let iy = -5; iy <= 5; iy += 1) {
      for (let iz = 0; iz < 3; iz += 1) {
        const edgeLift = Math.abs(iy) * 0.13;
        records.push(
          `${id}, ${x.toFixed(3)}, ${(iy * 1.8).toFixed(3)}, ${(crown + iz * 1.6 + edgeLift).toFixed(3)}`,
        );
        id += 1;
      }
    }
  }

  records.push("*ELEMENT", "; ignored by this MVP");
  return records.join("\n");
}
