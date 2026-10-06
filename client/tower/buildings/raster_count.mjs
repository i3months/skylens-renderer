// 래스터 호출 수·처리 화소 수 누적(진단용, 성능 시험이 읽는다). 래스터 함수가 끝날 때 한 번만 더하므로 화소 루프 비용은 지역 변수 증가분뿐이다.
// 화소 수: flat·tex = 깊이 시험을 통과해 onPixel 이 불린 수, lines = 선이 칸을 쓰려고 시도한 수(plot 호출), points = 검사한 점 수.
export const rasterCount = { calls: 0, pixels: 0 };
