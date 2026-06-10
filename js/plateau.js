'use strict';

// ── PLATEAU LOD2 integration ──────────────────────────────────────────────
// Pulls Japanese government 3D city models (real roof shapes, real heights,
// embedded photo textures) and drops them into our local-metres Three.js
// scene. Falls back to OSM in app.js when this returns null.
//
// We bypass the 3d-tiles-renderer library: it's ES-module-only and would
// drag in a second copy of THREE that won't share types with ours. Manual
// loading is ~150 LOC and gives us full control over LOD selection.

// ── City lat/lon bboxes that have confirmed PLATEAU coverage ───────────
// Catalog lookup happens at runtime via GraphQL; this table just tells us
// which city code to query for a given click point. Bboxes are loose — we
// only need them to win an "is this lat/lon inside this ward" check.
// ── City lat/lon bboxes that have confirmed PLATEAU coverage ───────────
// Catalog lookup happens at runtime via GraphQL; this table just tells us
// which city code to query for a given click point. Bboxes are loose — we
// only need them to win an "is this lat/lon inside this ward" check; if
// the catalog returns no LOD2/LOD1 dataset for that code we fall through
// to OSM extrusion in app.js.
//
// PLATEAU now covers ~230 municipalities; this is the subset where I'm
// reasonably confident there's at least LOD2 data plus some prefectural
// capitals / designated-city wards. Order matters only when two entries
// overlap — more-specific (smaller bbox) wins because we return the
// first match.
const PLATEAU_CITIES = [
  // ─── Tokyo 23 wards (13101-13123) — full LOD2 coverage ──────────────
  { code: '13101', name: '千代田区', bb: { s: 35.679, n: 35.708, w: 139.743, e: 139.787 } },
  { code: '13102', name: '中央区',   bb: { s: 35.655, n: 35.694, w: 139.748, e: 139.808 } },
  { code: '13103', name: '港区',     bb: { s: 35.605, n: 35.683, w: 139.708, e: 139.788 } },
  { code: '13104', name: '新宿区',   bb: { s: 35.668, n: 35.731, w: 139.675, e: 139.738 } },
  { code: '13105', name: '文京区',   bb: { s: 35.700, n: 35.742, w: 139.726, e: 139.778 } },
  { code: '13106', name: '台東区',   bb: { s: 35.696, n: 35.732, w: 139.766, e: 139.806 } },
  { code: '13107', name: '墨田区',   bb: { s: 35.683, n: 35.736, w: 139.787, e: 139.835 } },
  { code: '13108', name: '江東区',   bb: { s: 35.605, n: 35.704, w: 139.794, e: 139.873 } },
  { code: '13109', name: '品川区',   bb: { s: 35.585, n: 35.638, w: 139.708, e: 139.785 } },
  { code: '13110', name: '目黒区',   bb: { s: 35.605, n: 35.654, w: 139.658, e: 139.715 } },
  { code: '13111', name: '大田区',   bb: { s: 35.535, n: 35.616, w: 139.667, e: 139.825 } },
  { code: '13112', name: '世田谷区', bb: { s: 35.603, n: 35.681, w: 139.575, e: 139.677 } },
  { code: '13113', name: '渋谷区',   bb: { s: 35.645, n: 35.688, w: 139.670, e: 139.723 } },
  { code: '13114', name: '中野区',   bb: { s: 35.685, n: 35.731, w: 139.633, e: 139.685 } },
  { code: '13115', name: '杉並区',   bb: { s: 35.665, n: 35.738, w: 139.605, e: 139.675 } },
  { code: '13116', name: '豊島区',   bb: { s: 35.720, n: 35.751, w: 139.689, e: 139.736 } },
  { code: '13117', name: '北区',     bb: { s: 35.738, n: 35.793, w: 139.715, e: 139.769 } },
  { code: '13118', name: '荒川区',   bb: { s: 35.727, n: 35.752, w: 139.755, e: 139.810 } },
  { code: '13119', name: '板橋区',   bb: { s: 35.745, n: 35.804, w: 139.652, e: 139.738 } },
  { code: '13120', name: '練馬区',   bb: { s: 35.717, n: 35.795, w: 139.572, e: 139.683 } },
  { code: '13121', name: '足立区',   bb: { s: 35.748, n: 35.823, w: 139.748, e: 139.875 } },
  { code: '13122', name: '葛飾区',   bb: { s: 35.722, n: 35.793, w: 139.819, e: 139.913 } },
  { code: '13123', name: '江戸川区', bb: { s: 35.620, n: 35.781, w: 139.823, e: 139.940 } },
  // ─── Tokyo 多摩 (西東京) ─────────────────────────────────────────────
  { code: '13201', name: '八王子市', bb: { s: 35.580, n: 35.730, w: 139.220, e: 139.430 } },
  { code: '13202', name: '立川市',   bb: { s: 35.665, n: 35.735, w: 139.380, e: 139.450 } },
  { code: '13203', name: '武蔵野市', bb: { s: 35.685, n: 35.730, w: 139.535, e: 139.585 } },
  { code: '13204', name: '三鷹市',   bb: { s: 35.665, n: 35.710, w: 139.530, e: 139.590 } },
  { code: '13206', name: '府中市',   bb: { s: 35.640, n: 35.700, w: 139.450, e: 139.515 } },
  { code: '13208', name: '調布市',   bb: { s: 35.625, n: 35.685, w: 139.510, e: 139.580 } },
  { code: '13209', name: '町田市',   bb: { s: 35.530, n: 35.640, w: 139.330, e: 139.500 } },
  { code: '13212', name: '日野市',   bb: { s: 35.620, n: 35.690, w: 139.370, e: 139.440 } },
  { code: '13214', name: '国分寺市', bb: { s: 35.685, n: 35.730, w: 139.460, e: 139.520 } },
  { code: '13229', name: '西東京市', bb: { s: 35.710, n: 35.770, w: 139.520, e: 139.605 } },
  // ─── 横浜市 18 wards (14101-14118) ──────────────────────────────────
  { code: '14101', name: '横浜市鶴見区', bb: { s: 35.470, n: 35.530, w: 139.640, e: 139.720 } },
  { code: '14102', name: '横浜市神奈川区', bb: { s: 35.460, n: 35.510, w: 139.595, e: 139.660 } },
  { code: '14103', name: '横浜市西区',   bb: { s: 35.440, n: 35.480, w: 139.610, e: 139.640 } },
  { code: '14104', name: '横浜市中区',   bb: { s: 35.410, n: 35.460, w: 139.620, e: 139.680 } },
  { code: '14105', name: '横浜市南区',   bb: { s: 35.400, n: 35.450, w: 139.585, e: 139.625 } },
  { code: '14106', name: '横浜市保土ヶ谷区', bb: { s: 35.420, n: 35.480, w: 139.560, e: 139.620 } },
  { code: '14107', name: '横浜市磯子区', bb: { s: 35.370, n: 35.420, w: 139.595, e: 139.660 } },
  { code: '14108', name: '横浜市金沢区', bb: { s: 35.310, n: 35.390, w: 139.595, e: 139.680 } },
  { code: '14109', name: '横浜市港北区', bb: { s: 35.490, n: 35.560, w: 139.580, e: 139.660 } },
  { code: '14110', name: '横浜市戸塚区', bb: { s: 35.360, n: 35.450, w: 139.500, e: 139.580 } },
  { code: '14111', name: '横浜市港南区', bb: { s: 35.370, n: 35.420, w: 139.555, e: 139.620 } },
  { code: '14112', name: '横浜市旭区',   bb: { s: 35.430, n: 35.500, w: 139.480, e: 139.560 } },
  { code: '14113', name: '横浜市緑区',   bb: { s: 35.490, n: 35.560, w: 139.460, e: 139.560 } },
  { code: '14114', name: '横浜市瀬谷区', bb: { s: 35.440, n: 35.500, w: 139.430, e: 139.510 } },
  { code: '14115', name: '横浜市栄区',   bb: { s: 35.330, n: 35.390, w: 139.530, e: 139.605 } },
  { code: '14116', name: '横浜市泉区',   bb: { s: 35.380, n: 35.450, w: 139.450, e: 139.540 } },
  { code: '14117', name: '横浜市青葉区', bb: { s: 35.530, n: 35.605, w: 139.470, e: 139.580 } },
  { code: '14118', name: '横浜市都筑区', bb: { s: 35.520, n: 35.570, w: 139.555, e: 139.620 } },
  // ─── 川崎市 7 wards (14131-14137) ───────────────────────────────────
  { code: '14131', name: '川崎市川崎区', bb: { s: 35.475, n: 35.555, w: 139.700, e: 139.815 } },
  { code: '14132', name: '川崎市幸区',   bb: { s: 35.530, n: 35.580, w: 139.665, e: 139.715 } },
  { code: '14133', name: '川崎市中原区', bb: { s: 35.555, n: 35.605, w: 139.620, e: 139.690 } },
  { code: '14134', name: '川崎市高津区', bb: { s: 35.575, n: 35.625, w: 139.590, e: 139.665 } },
  { code: '14135', name: '川崎市多摩区', bb: { s: 35.595, n: 35.650, w: 139.520, e: 139.620 } },
  { code: '14136', name: '川崎市宮前区', bb: { s: 35.560, n: 35.620, w: 139.540, e: 139.620 } },
  { code: '14137', name: '川崎市麻生区', bb: { s: 35.575, n: 35.640, w: 139.450, e: 139.555 } },
  // ─── 相模原市 3 wards ─────────────────────────────────────────────
  { code: '14151', name: '相模原市緑区', bb: { s: 35.480, n: 35.700, w: 139.040, e: 139.380 } },
  { code: '14152', name: '相模原市中央区', bb: { s: 35.530, n: 35.605, w: 139.330, e: 139.420 } },
  { code: '14153', name: '相模原市南区', bb: { s: 35.470, n: 35.555, w: 139.330, e: 139.460 } },
  // ─── Kanagawa other ─────────────────────────────────────────────
  { code: '14201', name: '横須賀市', bb: { s: 35.190, n: 35.310, w: 139.560, e: 139.750 } },
  { code: '14203', name: '平塚市',   bb: { s: 35.290, n: 35.395, w: 139.270, e: 139.400 } },
  { code: '14204', name: '鎌倉市',   bb: { s: 35.270, n: 35.345, w: 139.510, e: 139.580 } },
  { code: '14205', name: '藤沢市',   bb: { s: 35.310, n: 35.420, w: 139.420, e: 139.530 } },
  { code: '14212', name: '厚木市',   bb: { s: 35.380, n: 35.520, w: 139.270, e: 139.400 } },
  { code: '14215', name: '海老名市', bb: { s: 35.410, n: 35.480, w: 139.360, e: 139.430 } },
  // ─── Saitama (11) ────────────────────────────────────────────────
  { code: '11101', name: 'さいたま市西区', bb: { s: 35.880, n: 35.960, w: 139.560, e: 139.640 } },
  { code: '11102', name: 'さいたま市北区', bb: { s: 35.900, n: 35.960, w: 139.580, e: 139.660 } },
  { code: '11103', name: 'さいたま市大宮区', bb: { s: 35.880, n: 35.930, w: 139.610, e: 139.665 } },
  { code: '11104', name: 'さいたま市見沼区', bb: { s: 35.900, n: 35.960, w: 139.640, e: 139.720 } },
  { code: '11105', name: 'さいたま市中央区', bb: { s: 35.860, n: 35.910, w: 139.610, e: 139.660 } },
  { code: '11106', name: 'さいたま市桜区',   bb: { s: 35.830, n: 35.890, w: 139.580, e: 139.650 } },
  { code: '11107', name: 'さいたま市浦和区', bb: { s: 35.840, n: 35.890, w: 139.625, e: 139.680 } },
  { code: '11108', name: 'さいたま市南区',   bb: { s: 35.800, n: 35.870, w: 139.620, e: 139.690 } },
  { code: '11109', name: 'さいたま市緑区',   bb: { s: 35.830, n: 35.910, w: 139.685, e: 139.760 } },
  { code: '11110', name: 'さいたま市岩槻区', bb: { s: 35.910, n: 36.010, w: 139.690, e: 139.790 } },
  { code: '11201', name: '川越市',   bb: { s: 35.880, n: 35.990, w: 139.440, e: 139.560 } },
  { code: '11203', name: '川口市',   bb: { s: 35.760, n: 35.870, w: 139.690, e: 139.790 } },
  { code: '11206', name: '所沢市',   bb: { s: 35.760, n: 35.860, w: 139.400, e: 139.530 } },
  { code: '11222', name: '越谷市',   bb: { s: 35.840, n: 35.940, w: 139.760, e: 139.840 } },
  // ─── Chiba (12) ─────────────────────────────────────────────────
  { code: '12101', name: '千葉市中央区', bb: { s: 35.580, n: 35.640, w: 140.090, e: 140.180 } },
  { code: '12102', name: '千葉市花見川区', bb: { s: 35.620, n: 35.700, w: 140.045, e: 140.130 } },
  { code: '12103', name: '千葉市稲毛区', bb: { s: 35.610, n: 35.665, w: 140.090, e: 140.155 } },
  { code: '12104', name: '千葉市若葉区', bb: { s: 35.595, n: 35.690, w: 140.135, e: 140.260 } },
  { code: '12105', name: '千葉市緑区',   bb: { s: 35.510, n: 35.610, w: 140.180, e: 140.290 } },
  { code: '12106', name: '千葉市美浜区', bb: { s: 35.610, n: 35.670, w: 140.020, e: 140.090 } },
  { code: '12204', name: '船橋市',   bb: { s: 35.660, n: 35.770, w: 139.940, e: 140.080 } },
  { code: '12203', name: '市川市',   bb: { s: 35.650, n: 35.770, w: 139.870, e: 139.960 } },
  { code: '12202', name: '銚子市',   bb: { s: 35.660, n: 35.780, w: 140.690, e: 140.880 } },
  { code: '12217', name: '柏市',     bb: { s: 35.815, n: 35.920, w: 139.940, e: 140.080 } },
  { code: '12207', name: '松戸市',   bb: { s: 35.740, n: 35.840, w: 139.870, e: 139.970 } },
  { code: '12227', name: '浦安市',   bb: { s: 35.610, n: 35.690, w: 139.870, e: 139.960 } },
  // ─── Ibaraki / Tochigi / Gunma / Niigata ─────────────────────────
  { code: '08201', name: '水戸市',   bb: { s: 36.300, n: 36.420, w: 140.380, e: 140.530 } },
  { code: '08220', name: 'つくば市', bb: { s: 35.990, n: 36.190, w: 140.020, e: 140.260 } },
  { code: '09201', name: '宇都宮市', bb: { s: 36.430, n: 36.660, w: 139.760, e: 139.970 } },
  { code: '10202', name: '高崎市',   bb: { s: 36.230, n: 36.430, w: 138.860, e: 139.130 } },
  { code: '10201', name: '前橋市',   bb: { s: 36.300, n: 36.520, w: 138.940, e: 139.180 } },
  { code: '15100', name: '新潟市',   bb: { s: 37.690, n: 37.990, w: 138.840, e: 139.290 } },
  // ─── 名古屋市 16 wards (23101-23116) ─────────────────────────────
  { code: '23101', name: '名古屋市千種区', bb: { s: 35.130, n: 35.190, w: 136.910, e: 136.990 } },
  { code: '23102', name: '名古屋市東区',   bb: { s: 35.165, n: 35.205, w: 136.890, e: 136.940 } },
  { code: '23103', name: '名古屋市北区',   bb: { s: 35.180, n: 35.240, w: 136.880, e: 136.940 } },
  { code: '23104', name: '名古屋市西区',   bb: { s: 35.180, n: 35.245, w: 136.830, e: 136.900 } },
  { code: '23105', name: '名古屋市中村区', bb: { s: 35.150, n: 35.205, w: 136.840, e: 136.895 } },
  { code: '23106', name: '名古屋市中区',   bb: { s: 35.140, n: 35.180, w: 136.880, e: 136.930 } },
  { code: '23107', name: '名古屋市昭和区', bb: { s: 35.110, n: 35.160, w: 136.910, e: 136.965 } },
  { code: '23108', name: '名古屋市瑞穂区', bb: { s: 35.105, n: 35.150, w: 136.920, e: 136.980 } },
  { code: '23109', name: '名古屋市熱田区', bb: { s: 35.100, n: 35.135, w: 136.895, e: 136.940 } },
  { code: '23110', name: '名古屋市中川区', bb: { s: 35.090, n: 35.180, w: 136.840, e: 136.910 } },
  { code: '23111', name: '名古屋市港区',   bb: { s: 35.060, n: 35.130, w: 136.770, e: 136.890 } },
  { code: '23112', name: '名古屋市南区',   bb: { s: 35.060, n: 35.115, w: 136.890, e: 136.965 } },
  { code: '23113', name: '名古屋市守山区', bb: { s: 35.190, n: 35.270, w: 136.940, e: 137.030 } },
  { code: '23114', name: '名古屋市緑区',   bb: { s: 35.060, n: 35.130, w: 136.940, e: 137.040 } },
  { code: '23115', name: '名古屋市名東区', bb: { s: 35.150, n: 35.210, w: 136.965, e: 137.030 } },
  { code: '23116', name: '名古屋市天白区', bb: { s: 35.100, n: 35.165, w: 136.945, e: 137.020 } },
  // ─── Aichi other ────────────────────────────────────────────────
  { code: '23202', name: '岡崎市',   bb: { s: 34.880, n: 35.100, w: 137.090, e: 137.300 } },
  { code: '23211', name: '豊田市',   bb: { s: 35.000, n: 35.290, w: 137.040, e: 137.400 } },
  { code: '23201', name: '豊橋市',   bb: { s: 34.620, n: 34.850, w: 137.260, e: 137.520 } },
  // ─── Shizuoka ───────────────────────────────────────────────────
  { code: '22130', name: '浜松市',   bb: { s: 34.620, n: 35.090, w: 137.530, e: 137.940 } },
  { code: '22100', name: '静岡市',   bb: { s: 34.890, n: 35.350, w: 138.220, e: 138.620 } },
  { code: '22203', name: '沼津市',   bb: { s: 35.040, n: 35.200, w: 138.760, e: 138.920 } },
  { code: '22210', name: '富士市',   bb: { s: 35.100, n: 35.310, w: 138.580, e: 138.800 } },
  // ─── 京都市 11 wards (26101-26111) ───────────────────────────────
  { code: '26101', name: '京都市北区',     bb: { s: 35.030, n: 35.270, w: 135.660, e: 135.785 } },
  { code: '26102', name: '京都市上京区',   bb: { s: 35.020, n: 35.045, w: 135.735, e: 135.770 } },
  { code: '26103', name: '京都市左京区',   bb: { s: 35.000, n: 35.290, w: 135.770, e: 135.880 } },
  { code: '26104', name: '京都市中京区',   bb: { s: 35.000, n: 35.020, w: 135.730, e: 135.780 } },
  { code: '26105', name: '京都市東山区',   bb: { s: 34.980, n: 35.015, w: 135.760, e: 135.800 } },
  { code: '26106', name: '京都市下京区',   bb: { s: 34.980, n: 35.000, w: 135.730, e: 135.780 } },
  { code: '26107', name: '京都市南区',     bb: { s: 34.940, n: 34.990, w: 135.720, e: 135.795 } },
  { code: '26108', name: '京都市右京区',   bb: { s: 34.960, n: 35.220, w: 135.560, e: 135.760 } },
  { code: '26109', name: '京都市伏見区',   bb: { s: 34.880, n: 34.970, w: 135.700, e: 135.840 } },
  { code: '26110', name: '京都市山科区',   bb: { s: 34.960, n: 35.030, w: 135.800, e: 135.870 } },
  { code: '26111', name: '京都市西京区',   bb: { s: 34.910, n: 35.080, w: 135.610, e: 135.730 } },
  // ─── 大阪市 24 wards (27102-27128 — 27101 doesn't exist, 27106 同) ──
  { code: '27102', name: '大阪市都島区',   bb: { s: 34.690, n: 34.730, w: 135.510, e: 135.550 } },
  { code: '27103', name: '大阪市福島区',   bb: { s: 34.690, n: 34.710, w: 135.470, e: 135.500 } },
  { code: '27104', name: '大阪市此花区',   bb: { s: 34.660, n: 34.710, w: 135.405, e: 135.480 } },
  { code: '27106', name: '大阪市西区',     bb: { s: 34.670, n: 34.690, w: 135.475, e: 135.510 } },
  { code: '27107', name: '大阪市港区',     bb: { s: 34.650, n: 34.685, w: 135.430, e: 135.475 } },
  { code: '27108', name: '大阪市大正区',   bb: { s: 34.620, n: 34.665, w: 135.460, e: 135.500 } },
  { code: '27109', name: '大阪市天王寺区', bb: { s: 34.650, n: 34.680, w: 135.510, e: 135.535 } },
  { code: '27111', name: '大阪市浪速区',   bb: { s: 34.650, n: 34.675, w: 135.485, e: 135.510 } },
  { code: '27113', name: '大阪市西淀川区', bb: { s: 34.690, n: 34.730, w: 135.420, e: 135.475 } },
  { code: '27114', name: '大阪市東淀川区', bb: { s: 34.720, n: 34.770, w: 135.495, e: 135.560 } },
  { code: '27115', name: '大阪市東成区',   bb: { s: 34.660, n: 34.685, w: 135.535, e: 135.570 } },
  { code: '27116', name: '大阪市生野区',   bb: { s: 34.640, n: 34.665, w: 135.530, e: 135.570 } },
  { code: '27117', name: '大阪市旭区',     bb: { s: 34.720, n: 34.745, w: 135.540, e: 135.575 } },
  { code: '27118', name: '大阪市城東区',   bb: { s: 34.680, n: 34.715, w: 135.535, e: 135.570 } },
  { code: '27119', name: '大阪市阿倍野区', bb: { s: 34.620, n: 34.660, w: 135.510, e: 135.540 } },
  { code: '27120', name: '大阪市住吉区',   bb: { s: 34.595, n: 34.630, w: 135.490, e: 135.535 } },
  { code: '27121', name: '大阪市東住吉区', bb: { s: 34.600, n: 34.640, w: 135.530, e: 135.575 } },
  { code: '27122', name: '大阪市西成区',   bb: { s: 34.630, n: 34.655, w: 135.480, e: 135.515 } },
  { code: '27123', name: '大阪市淀川区',   bb: { s: 34.715, n: 34.750, w: 135.450, e: 135.510 } },
  { code: '27124', name: '大阪市鶴見区',   bb: { s: 34.700, n: 34.730, w: 135.560, e: 135.600 } },
  { code: '27125', name: '大阪市住之江区', bb: { s: 34.600, n: 34.665, w: 135.430, e: 135.500 } },
  { code: '27126', name: '大阪市平野区',   bb: { s: 34.605, n: 34.640, w: 135.555, e: 135.605 } },
  { code: '27127', name: '大阪市北区',     bb: { s: 34.695, n: 34.730, w: 135.485, e: 135.525 } },
  { code: '27128', name: '大阪市中央区',   bb: { s: 34.665, n: 34.700, w: 135.500, e: 135.535 } },
  // ─── 堺市 7 wards + Osaka pref ──────────────────────────────────
  { code: '27141', name: '堺市堺区',   bb: { s: 34.560, n: 34.610, w: 135.450, e: 135.510 } },
  { code: '27142', name: '堺市中区',   bb: { s: 34.520, n: 34.565, w: 135.475, e: 135.530 } },
  { code: '27143', name: '堺市東区',   bb: { s: 34.520, n: 34.560, w: 135.530, e: 135.565 } },
  { code: '27144', name: '堺市西区',   bb: { s: 34.520, n: 34.580, w: 135.420, e: 135.495 } },
  { code: '27145', name: '堺市南区',   bb: { s: 34.460, n: 34.530, w: 135.470, e: 135.550 } },
  { code: '27146', name: '堺市北区',   bb: { s: 34.555, n: 34.590, w: 135.495, e: 135.560 } },
  { code: '27147', name: '堺市美原区', bb: { s: 34.520, n: 34.565, w: 135.560, e: 135.610 } },
  { code: '27203', name: '豊中市',   bb: { s: 34.720, n: 34.825, w: 135.430, e: 135.500 } },
  { code: '27205', name: '吹田市',   bb: { s: 34.730, n: 34.830, w: 135.480, e: 135.560 } },
  { code: '27207', name: '高槻市',   bb: { s: 34.800, n: 34.940, w: 135.555, e: 135.680 } },
  { code: '27211', name: '茨木市',   bb: { s: 34.790, n: 34.940, w: 135.530, e: 135.610 } },
  { code: '27212', name: '八尾市',   bb: { s: 34.600, n: 34.660, w: 135.575, e: 135.660 } },
  { code: '27215', name: '寝屋川市', bb: { s: 34.730, n: 34.795, w: 135.605, e: 135.665 } },
  { code: '27227', name: '東大阪市', bb: { s: 34.610, n: 34.730, w: 135.575, e: 135.700 } },
  // ─── 兵庫 神戸市 9 wards + Hyogo ────────────────────────────────
  { code: '28101', name: '神戸市東灘区', bb: { s: 34.690, n: 34.770, w: 135.220, e: 135.290 } },
  { code: '28102', name: '神戸市灘区',   bb: { s: 34.690, n: 34.780, w: 135.200, e: 135.260 } },
  { code: '28105', name: '神戸市兵庫区', bb: { s: 34.640, n: 34.770, w: 135.140, e: 135.200 } },
  { code: '28106', name: '神戸市長田区', bb: { s: 34.640, n: 34.730, w: 135.110, e: 135.165 } },
  { code: '28107', name: '神戸市須磨区', bb: { s: 34.630, n: 34.745, w: 135.070, e: 135.150 } },
  { code: '28108', name: '神戸市垂水区', bb: { s: 34.610, n: 34.700, w: 135.020, e: 135.090 } },
  { code: '28109', name: '神戸市北区',   bb: { s: 34.730, n: 34.910, w: 135.090, e: 135.310 } },
  { code: '28110', name: '神戸市中央区', bb: { s: 34.660, n: 34.770, w: 135.170, e: 135.230 } },
  { code: '28111', name: '神戸市西区',   bb: { s: 34.630, n: 34.780, w: 134.910, e: 135.080 } },
  { code: '28201', name: '姫路市',   bb: { s: 34.700, n: 34.950, w: 134.580, e: 134.810 } },
  { code: '28204', name: '西宮市',   bb: { s: 34.700, n: 34.860, w: 135.295, e: 135.395 } },
  // ─── 札幌市 10 wards ───────────────────────────────────────────
  { code: '01101', name: '札幌市中央区', bb: { s: 43.020, n: 43.094, w: 141.291, e: 141.378 } },
  { code: '01102', name: '札幌市北区',   bb: { s: 43.090, n: 43.230, w: 141.290, e: 141.395 } },
  { code: '01103', name: '札幌市東区',   bb: { s: 43.075, n: 43.215, w: 141.345, e: 141.450 } },
  { code: '01104', name: '札幌市白石区', bb: { s: 43.030, n: 43.085, w: 141.395, e: 141.485 } },
  { code: '01105', name: '札幌市豊平区', bb: { s: 42.980, n: 43.060, w: 141.345, e: 141.430 } },
  { code: '01106', name: '札幌市南区',   bb: { s: 42.800, n: 43.020, w: 141.180, e: 141.405 } },
  { code: '01107', name: '札幌市西区',   bb: { s: 43.040, n: 43.150, w: 141.190, e: 141.310 } },
  { code: '01108', name: '札幌市厚別区', bb: { s: 43.000, n: 43.075, w: 141.470, e: 141.540 } },
  { code: '01109', name: '札幌市手稲区', bb: { s: 43.080, n: 43.230, w: 141.190, e: 141.340 } },
  { code: '01110', name: '札幌市清田区', bb: { s: 42.940, n: 43.020, w: 141.380, e: 141.470 } },
  // ─── 仙台市 5 wards ────────────────────────────────────────────
  { code: '04101', name: '仙台市青葉区', bb: { s: 38.230, n: 38.420, w: 140.580, e: 140.900 } },
  { code: '04102', name: '仙台市宮城野区', bb: { s: 38.220, n: 38.310, w: 140.890, e: 141.010 } },
  { code: '04103', name: '仙台市若林区', bb: { s: 38.190, n: 38.270, w: 140.860, e: 141.000 } },
  { code: '04104', name: '仙台市太白区', bb: { s: 38.090, n: 38.260, w: 140.700, e: 140.900 } },
  { code: '04105', name: '仙台市泉区',   bb: { s: 38.280, n: 38.450, w: 140.770, e: 140.940 } },
  // ─── 福岡市 7 wards + 北九州市 7 wards ────────────────────────
  { code: '40131', name: '福岡市東区',   bb: { s: 33.620, n: 33.770, w: 130.385, e: 130.480 } },
  { code: '40132', name: '福岡市博多区', bb: { s: 33.555, n: 33.625, w: 130.395, e: 130.470 } },
  { code: '40133', name: '福岡市中央区', bb: { s: 33.555, n: 33.605, w: 130.350, e: 130.410 } },
  { code: '40134', name: '福岡市南区',   bb: { s: 33.530, n: 33.585, w: 130.395, e: 130.460 } },
  { code: '40135', name: '福岡市西区',   bb: { s: 33.555, n: 33.690, w: 130.150, e: 130.360 } },
  { code: '40136', name: '福岡市城南区', bb: { s: 33.540, n: 33.590, w: 130.350, e: 130.405 } },
  { code: '40137', name: '福岡市早良区', bb: { s: 33.490, n: 33.625, w: 130.270, e: 130.390 } },
  { code: '40101', name: '北九州市門司区', bb: { s: 33.880, n: 33.985, w: 130.890, e: 131.030 } },
  { code: '40103', name: '北九州市若松区', bb: { s: 33.870, n: 33.965, w: 130.700, e: 130.810 } },
  { code: '40105', name: '北九州市戸畑区', bb: { s: 33.860, n: 33.910, w: 130.780, e: 130.840 } },
  { code: '40106', name: '北九州市小倉北区', bb: { s: 33.840, n: 33.920, w: 130.840, e: 130.910 } },
  { code: '40107', name: '北九州市小倉南区', bb: { s: 33.700, n: 33.870, w: 130.820, e: 130.965 } },
  { code: '40108', name: '北九州市八幡東区', bb: { s: 33.820, n: 33.890, w: 130.770, e: 130.840 } },
  { code: '40109', name: '北九州市八幡西区', bb: { s: 33.770, n: 33.870, w: 130.640, e: 130.790 } },
  // ─── 広島市 8 wards + Hiroshima ───────────────────────────────
  { code: '34101', name: '広島市中区',   bb: { s: 34.370, n: 34.405, w: 132.430, e: 132.480 } },
  { code: '34102', name: '広島市東区',   bb: { s: 34.380, n: 34.475, w: 132.470, e: 132.580 } },
  { code: '34103', name: '広島市南区',   bb: { s: 34.310, n: 34.395, w: 132.450, e: 132.520 } },
  { code: '34104', name: '広島市西区',   bb: { s: 34.370, n: 34.490, w: 132.380, e: 132.460 } },
  { code: '34105', name: '広島市安佐南区', bb: { s: 34.440, n: 34.580, w: 132.420, e: 132.530 } },
  { code: '34106', name: '広島市安佐北区', bb: { s: 34.500, n: 34.700, w: 132.430, e: 132.660 } },
  { code: '34107', name: '広島市安芸区', bb: { s: 34.330, n: 34.450, w: 132.530, e: 132.640 } },
  { code: '34108', name: '広島市佐伯区', bb: { s: 34.320, n: 34.500, w: 132.250, e: 132.420 } },
  { code: '34207', name: '福山市',     bb: { s: 34.380, n: 34.690, w: 133.220, e: 133.530 } },
  // ─── Other prefectural capitals / notable cities ──────────────
  { code: '33101', name: '岡山市北区', bb: { s: 34.530, n: 34.940, w: 133.640, e: 133.990 } },
  { code: '33102', name: '岡山市中区', bb: { s: 34.580, n: 34.690, w: 133.940, e: 134.010 } },
  { code: '33103', name: '岡山市東区', bb: { s: 34.580, n: 34.770, w: 133.985, e: 134.150 } },
  { code: '33104', name: '岡山市南区', bb: { s: 34.470, n: 34.640, w: 133.820, e: 134.000 } },
  { code: '37201', name: '高松市',   bb: { s: 34.150, n: 34.420, w: 133.840, e: 134.130 } },
  { code: '38201', name: '松山市',   bb: { s: 33.700, n: 34.040, w: 132.530, e: 132.870 } },
  { code: '39201', name: '高知市',   bb: { s: 33.400, n: 33.660, w: 133.400, e: 133.640 } },
  { code: '47201', name: '那覇市',   bb: { s: 26.180, n: 26.260, w: 127.640, e: 127.740 } },
  { code: '29201', name: '奈良市',   bb: { s: 34.610, n: 34.840, w: 135.700, e: 136.000 } },
  { code: '17201', name: '金沢市',   bb: { s: 36.430, n: 36.660, w: 136.530, e: 136.850 } },
  { code: '20201', name: '長野市',   bb: { s: 36.510, n: 36.890, w: 137.940, e: 138.350 } },
  { code: '20202', name: '松本市',   bb: { s: 36.030, n: 36.380, w: 137.760, e: 138.130 } },
  // ─── 熊本市 5 wards + Kumamoto ────────────────────────────────
  { code: '43101', name: '熊本市中央区', bb: { s: 32.770, n: 32.840, w: 130.690, e: 130.770 } },
  { code: '43102', name: '熊本市東区',   bb: { s: 32.740, n: 32.820, w: 130.750, e: 130.830 } },
  { code: '43103', name: '熊本市西区',   bb: { s: 32.700, n: 32.830, w: 130.580, e: 130.700 } },
  { code: '43104', name: '熊本市南区',   bb: { s: 32.640, n: 32.770, w: 130.600, e: 130.760 } },
  { code: '43105', name: '熊本市北区',   bb: { s: 32.820, n: 32.940, w: 130.620, e: 130.770 } },
  { code: '46201', name: '鹿児島市', bb: { s: 31.470, n: 31.680, w: 130.470, e: 130.700 } },
];

// Return ALL city entries whose bbox contains the click point. With the
// 23-Tokyo-wards + 18-Yokohama-wards + N-Osaka-wards expansion the same
// point may sit inside several entries (overlapping ward bboxes), and we
// want the caller to be able to try each in priority order until one has
// a LOD2 dataset in the catalog.
function findPlateauCities(lat, lon) {
  const hits = [];
  for (const c of PLATEAU_CITIES) {
    if (lat >= c.bb.s && lat <= c.bb.n && lon >= c.bb.w && lon <= c.bb.e) hits.push(c);
  }
  return hits;
}

// Back-compat: callers that only want one city get the first hit.
function findPlateauCity(lat, lon) {
  const hits = findPlateauCities(lat, lon);
  return hits[0] || null;
}

// All city entries whose bbox INTERSECTS the request bbox. A map area
// frequently straddles ward boundaries — Tokyo Station sits right on the
// Chiyoda/Chuo line — and loading only the click-point's ward leaves
// every building across the boundary missing (half the map empty).
function findPlateauCitiesForBbox(bb) {
  const hits = [];
  for (const c of PLATEAU_CITIES) {
    if (!(c.bb.e < bb.w || c.bb.w > bb.e || c.bb.n < bb.s || c.bb.s > bb.n)) hits.push(c);
  }
  return hits;
}

// ── PLATEAU catalog API — resolve cityCode → best available tileset URL ─
// Returns { url, lod } where lod ∈ {'lod2','lod1'}. Prefers LOD2 (real
// roof shapes + measured heights); falls back to LOD1 (extruded boxes).
// Cached in sessionStorage (v3 key) so re-running the same city skips the
// API call.
const _PLATEAU_LOOKUP_CACHE = {};

// MLIT migrated the datacatalog GraphQL schema. The old query
//   datasets(input: {cityCode, type: "plateau"}) { items { items {...} } }
// now 400s. The current (v3) schema uses areaCodes + a union return with
// a PlateauDataset fragment exposing per-item lod / texture flags.
function _plateauQueryV3(cityCode) {
  return `{
    datasets(input: { areaCodes: ["${cityCode}"], includeTypes: ["bldg"] }) {
      name
      ... on PlateauDataset {
        items { id name url format lod texture }
      }
    }
  }`;
}
function _plateauQueryLegacy(cityCode) {
  return `{
    datasets(input: {cityCode: "${cityCode}", type: "plateau"}) {
      items { items { name url type } }
    }
  }`;
}

async function _plateauGraphql(query) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 8000);
  const res = await fetch('https://api.plateauview.mlit.go.jp/datacatalog/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: ctrl.signal,
  });
  return { ok: res.ok, status: res.status, json: res.ok ? await res.json().catch(() => null) : null };
}

// Flatten either schema's response into a uniform list of
// { name, url, lod?, texture? }.
function _plateauFlatten(json) {
  const ds = json?.data?.datasets;
  if (!Array.isArray(ds)) return [];
  const out = [];
  for (const d of ds) {
    // v3: dataset has items[] directly (PlateauDataset fragment).
    if (Array.isArray(d.items)) {
      for (const it of d.items) {
        if (it && it.url) out.push({ name: it.name || d.name, url: it.url, lod: it.lod, texture: it.texture });
      }
    }
    // legacy: dataset.items[].items[]
    if (d.items && Array.isArray(d.items.items)) {
      for (const it of d.items.items) {
        if (it && it.url) out.push({ name: it.name, url: it.url });
      }
    }
  }
  return out;
}

async function fetchPlateauTilesetUrl(cityCode) {
  if (_PLATEAU_LOOKUP_CACHE[cityCode] !== undefined) return _PLATEAU_LOOKUP_CACHE[cityCode];
  // Distinguish "no cache entry" (getItem → null) from a cached negative
  // result (the string 'null'): both used to parse to null, so negative
  // results were re-queried on every run.
  try {
    const raw = sessionStorage.getItem('plateau:v3:' + cityCode);
    if (raw !== null) {
      const cached = JSON.parse(raw);
      _PLATEAU_LOOKUP_CACHE[cityCode] = cached;
      return cached;
    }
  } catch {}

  let result = null;
  try {
    // A ward code may have nothing registered under it: designated-city
    // data (大阪市・横浜市・名古屋市…) is often catalogued under the CITY
    // code (e.g. 27100) rather than the ward codes (27127…). Try the
    // ward first, then plausible parent codes.
    const candidates = [cityCode];
    if (!/00$/.test(cityCode)) {
      candidates.push(cityCode.slice(0, 3) + '00');   // 27127 → 27100 (大阪市)
      candidates.push(cityCode.slice(0, 4) + '0');    // 40131 → 40130 (福岡市)
    }
    let bldg = [];
    for (const code of [...new Set(candidates)]) {
      // Try the current v3 schema first, fall back to the legacy one.
      let r = await _plateauGraphql(_plateauQueryV3(code));
      if ((!r.ok || r.json?.errors)) {
        const why = r.ok ? JSON.stringify(r.json.errors).slice(0, 160) : 'HTTP ' + r.status;
        console.warn(`[PLATEAU ${code}] v3 query failed (${why}); trying legacy`);
        r = await _plateauGraphql(_plateauQueryLegacy(code));
      }
      if (!r.ok) {
        console.warn(`[PLATEAU ${code}] catalog HTTP ${r.status}`);
        continue;
      }
      if (r.json?.errors) console.warn(`[PLATEAU ${code}] GraphQL errors:`, r.json.errors);

      const all = _plateauFlatten(r.json);
      bldg = all.filter(i => i.url && i.url.includes('bldg') && i.url.endsWith('tileset.json'));
      if (bldg.length) {
        console.log(`[PLATEAU ${code}] catalog returned ${bldg.length} bldg dataset(s):`);
        for (const i of bldg) console.log('  •', i.name || '(no name)',
          i.lod != null ? `lod${i.lod}` : '', i.texture != null ? `tex=${i.texture}` : '', '→', i.url);
        break;
      }
    }

    // Classify by the explicit lod / texture fields when v3 provides them,
    // else fall back to URL/name regex (legacy schema).
    const tag = i => ((i.url || '') + ' ' + (i.name || '')).toLowerCase();
    const lodOf = i => i.lod != null ? Number(i.lod)
                     : /lod2/i.test(i.url) ? 2 : /lod1/i.test(i.url) ? 1 : 0;
    const texOf = i => {
      // v3 PlateauDatasetItem.texture is the enum TEXTURE / NONE — trust
      // it before any URL guessing.
      if (i.texture === 'TEXTURE') return 'hi';
      if (i.texture === 'NONE') return 'no';
      if (typeof i.texture === 'boolean') return i.texture ? 'hi' : 'no';
      if (/no[_\- ]?texture|テクスチャ(無|なし)/i.test(tag(i))) return 'no';
      if (/low[_\- ]?(resolution|res)[_\- ]?texture|低解像度/i.test(tag(i))) return 'low';
      if (/texture|テクスチャ/i.test(tag(i))) return 'hi';
      return 'unknown';
    };
    // Score: LOD2+ (real roof shapes) is the baseline requirement, then
    // TEXTURE outweighs a further LOD step — a textured LOD2 looks far
    // better in this viewer than a white LOD3 — then higher LOD breaks
    // ties. LOD1 only as a last resort.
    const texRank = { hi: 3, low: 2, unknown: 1, no: 0 };
    const scoreOf = s => (s.lod >= 2 ? 8 : 0) + s.lod + texRank[s.tex] * 2;
    const scored = bldg.map(i => ({ i, lod: lodOf(i), tex: texOf(i) }))
      .sort((a, b) => scoreOf(b) - scoreOf(a));
    const best = scored[0];
    if (best) {
      const lodTag = 'lod' + best.lod;
      const texTag = best.tex === 'no' ? ' (no-texture)'
                  : best.tex === 'low' ? ' (low-res tex)'
                  : best.tex === 'hi' ? ' (textured)' : '';
      console.log(`[PLATEAU ${cityCode}] picked:`, best.i.name || best.i.url, '→', lodTag + texTag);
      result = { url: best.i.url, lod: lodTag, label: lodTag.toUpperCase() + texTag };
    }
  } catch (e) {
    console.warn(`[PLATEAU ${cityCode}] catalog query failed:`, e.message || e);
  }
  _PLATEAU_LOOKUP_CACHE[cityCode] = result;
  try { sessionStorage.setItem('plateau:v3:' + cityCode, JSON.stringify(result)); } catch {}
  return result;
}

// Walk the candidate cities for a click point, return the first that has
// PLATEAU data. Prefer cities where LOD2 is available over those with only
// LOD1, even if LOD1 was earlier in the candidates list.
async function fetchPlateauBestForPoint(lat, lon) {
  const cities = findPlateauCities(lat, lon);
  let lod1Fallback = null;
  for (const city of cities) {
    const r = await fetchPlateauTilesetUrl(city.code);
    if (!r) continue;
    if (r.lod === 'lod2') return { city, ...r };
    if (!lod1Fallback) lod1Fallback = { city, ...r };
  }
  return lod1Fallback;
}

// Resolve EVERY city whose bbox intersects the request bbox to its best
// tileset. Returns an array of { city, url, lod, label } or null. The
// caller loads each tileset and merges — that's what fills in the
// buildings across ward boundaries instead of stopping at them.
async function fetchPlateauForBbox(bb) {
  const cities = findPlateauCitiesForBbox(bb);
  const picks = [];
  const seenUrls = new Set();
  for (const city of cities) {
    const r = await fetchPlateauTilesetUrl(city.code);
    if (!r) continue;
    // Dedupe: several ward codes can resolve to the SAME city-level
    // tileset (designated-city fallback) — loading it once per ward
    // would draw every building N times.
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    picks.push({ city, ...r });
  }
  if (!picks.length) return null;
  // If at least one ward has LOD2, drop LOD1-only neighbours? No — a
  // neighbour ward's LOD1 boxes still beat an empty half-map. Keep all;
  // each pick is already its own city's best available.
  return picks;
}

// ── ECEF math ───────────────────────────────────────────────────────────
// WGS84 ellipsoid constants.
const WGS84_A  = 6378137.0;
const WGS84_E2 = 0.006694379990141316;  // first eccentricity squared

function geodeticToEcef(latDeg, lonDeg, h = 0) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  return new THREE.Vector3(
    (N + h) * cLat * cLon,
    (N + h) * cLat * sLon,
    (N * (1 - WGS84_E2) + h) * sLat
  );
}

// Build a 4×4 transform that takes ECEF coordinates to our local frame:
// +X east, +Y up, +Z south, NW corner of `bb` at (0, 0, 0).
function buildEcefToLocalMatrix(bb) {
  const xSize = bboxXSize(bb), zSize = bboxZSize(bb);
  const lat0 = (bb.n + bb.s) / 2;
  const lon0 = (bb.w + bb.e) / 2;
  const O = geodeticToEcef(lat0, lon0, 0);

  const lat = lat0 * Math.PI / 180, lon = lon0 * Math.PI / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const sLon = Math.sin(lon), cLon = Math.cos(lon);

  // ENU basis vectors expressed in ECEF coordinates.
  const east  = new THREE.Vector3(-sLon,            cLon,           0);
  const north = new THREE.Vector3(-sLat * cLon,    -sLat * sLon,    cLat);
  const up    = new THREE.Vector3( cLat * cLon,     cLat * sLon,    sLat);

  // local = R^T · (ecef - O) + (xSize/2, 0, zSize/2)
  // Row layout — east row, up row, -north row, identity translation row.
  // Translation column folds in the offset to NW-corner origin.
  const m = new THREE.Matrix4();
  m.set(
     east.x,    east.y,    east.z,    -east.dot(O)  + xSize / 2,
     up.x,      up.y,      up.z,      -up.dot(O),
    -north.x,  -north.y,  -north.z,    north.dot(O) + zSize / 2,
     0,         0,         0,          1
  );
  return m;
}

// ── b3dm parser ────────────────────────────────────────────────────────
// b3dm = 28-byte header + featureTable (JSON + binary) + batchTable
//        (JSON + binary) + embedded glb. Returns { glb, rtcCenter } —
// PLATEAU's tiles store the tile origin in the feature table's
// RTC_CENTER (ECEF metres) and use Draco-compressed vertices that
// sit relative to it, so we have to bake the centre into the tile
// transform or every building lands at the wrong spot.
function parseB3dm(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1),
                                    view.getUint8(2), view.getUint8(3));
  if (magic !== 'b3dm') throw new Error(`not a b3dm tile (magic=${magic})`);
  const ftJsonLen = view.getUint32(12, true);
  const ftBinLen  = view.getUint32(16, true);
  const btJsonLen = view.getUint32(20, true);
  const btBinLen  = view.getUint32(24, true);
  let rtcCenter = null;
  if (ftJsonLen > 0) {
    try {
      const ftJsonBytes = new Uint8Array(buffer, 28, ftJsonLen);
      const ft = JSON.parse(new TextDecoder().decode(ftJsonBytes));
      if (Array.isArray(ft.RTC_CENTER) && ft.RTC_CENTER.length === 3) rtcCenter = ft.RTC_CENTER;
    } catch {}
  }
  const glb = buffer.slice(28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen);
  return { glb, rtcCenter };
}

// glTF binary: 12-byte header (magic, version, length), then chunks. The
// first chunk is the JSON. Read it and pull `extensions.CESIUM_RTC.center`
// — the alternative way PLATEAU encodes the per-tile ECEF anchor when it
// isn't in the b3dm feature table.
function readGlbCesiumRtcCenter(glb) {
  try {
    const view = new DataView(glb);
    // "glTF" little-endian = 0x46546C67
    if (view.getUint32(0, true) !== 0x46546C67) return null;
    const jsonLen = view.getUint32(12, true);
    const jsonBytes = new Uint8Array(glb, 20, jsonLen);
    const json = JSON.parse(new TextDecoder().decode(jsonBytes));
    const c = json && json.extensions && json.extensions.CESIUM_RTC && json.extensions.CESIUM_RTC.center;
    return (Array.isArray(c) && c.length === 3) ? c : null;
  } catch { return null; }
}

// ── Bounding-volume tests ─────────────────────────────────────────────
// A 3D Tiles `region` is [west, south, east, north, minH, maxH] in radians.
// We use it to discard tiles whose ground footprint doesn't touch our bbox.
function tileRegionIntersects(region, bb) {
  if (!region) return true;  // unknown bounding type → keep, be conservative
  const w = region[0] * 180 / Math.PI, s = region[1] * 180 / Math.PI;
  const e = region[2] * 180 / Math.PI, n = region[3] * 180 / Math.PI;
  return !(e < bb.w || w > bb.e || n < bb.s || s > bb.n);
}

// ── Tile loader ────────────────────────────────────────────────────────
// Walk the tile hierarchy, collect leaves whose region intersects bb, then
// fetch + parse + add to scene with capped concurrency. No streaming LOD —
// we load the smallest level of the hierarchy that covers the bbox.
async function loadPlateauBuildings(tilesetUrl, bb, onProgress) {
  if (typeof THREE.GLTFLoader !== 'function') {
    throw new Error('GLTFLoader not loaded — add the three GLTFLoader script tag');
  }

  onProgress && onProgress(0, 'PLATEAU カタログ読込中…');

  // Resolve a content reference (relative or absolute) against a base URL.
  // Use the URL constructor so "../", "./" and root-relative "/x" refs all
  // resolve correctly — naive base+ref concatenation builds broken URLs
  // for those and the tiles silently fail to load.
  const resolveUrl = (ref, base) => {
    try { return new URL(ref, base).href; }
    catch { return /^https?:\/\//i.test(ref) ? ref : base + ref; }
  };

  // Pull the content URI from a tile, handling both 3D Tiles 1.0
  // (content.url) and 1.1 (content.uri). PLATEAU's published tilesets are
  // overwhelmingly 1.0 — checking only `uri` (as we did) found nothing,
  // every tile was skipped, leaves stayed empty, and we silently fell back
  // to OSM. That's why the buildings looked like our box extrusions and
  // not PLATEAU.
  const contentUri = tile => tile && tile.content
    ? (tile.content.uri || tile.content.url || null) : null;

  // Recursively walk the tile hierarchy, following EXTERNAL tileset.json
  // references (PLATEAU nests per-district tilesets this way). Leaves are
  // tiles whose content is a real b3dm/glb. Async because external
  // tilesets must be fetched.
  const leaves = [];
  const visited = new Set();   // guard against cyclic external refs

  async function walk(tile, inherited, baseUrl, inheritedRegion, inheritedRefine) {
    const region = (tile.boundingVolume && tile.boundingVolume.region) || inheritedRegion;
    if (!tileRegionIntersects(region, bb)) return;

    // `refine` is inherited down the tree per the 3D Tiles spec.
    const refine = String(tile.refine || inheritedRefine || 'REPLACE').toUpperCase();
    const xform = inherited.clone();
    if (tile.transform) xform.multiply(new THREE.Matrix4().fromArray(tile.transform));

    const uri = contentUri(tile);
    const hasChildren = Array.isArray(tile.children) && tile.children.length > 0;
    // A tile can carry BOTH children and content. With REPLACE refinement
    // the parent's content is a coarser duplicate of its children — loading
    // both double-draws. With ADD refinement the parent content is part of
    // the model and must be loaded alongside the children, or buildings
    // silently disappear.
    const loadOwnContent = uri && (!hasChildren || refine === 'ADD');

    if (loadOwnContent) {
      const absUrl = resolveUrl(uri, baseUrl);
      if (/\.json($|\?)/i.test(absUrl)) {
        // External tileset reference → fetch and recurse.
        if (!visited.has(absUrl)) {
          visited.add(absUrl);
          try {
            const sub = await fetch(absUrl).then(r => r.json());
            const subBase = absUrl.substring(0, absUrl.lastIndexOf('/') + 1);
            if (sub && sub.root) await walk(sub.root, xform, subBase, region, refine);
          } catch (e) {
            console.warn('PLATEAU external tileset failed:', absUrl, e.message);
          }
        }
      } else {
        // Real content tile (b3dm / glb). Store its ABSOLUTE url so loadOne
        // doesn't need to know which nested tileset it came from. Carry the
        // tile's bounding region so loadOne has a fallback ECEF anchor when
        // the b3dm has no RTC_CENTER and no CESIUM_RTC extension.
        leaves.push({ url: absUrl, transform: xform, region, _idx: leaves.length });
      }
    }

    if (hasChildren) {
      for (const c of tile.children) await walk(c, xform, baseUrl, region, refine);
    }
  }

  const rootTileset = await fetch(tilesetUrl).then(r => r.json());
  const rootBase = tilesetUrl.substring(0, tilesetUrl.lastIndexOf('/') + 1);
  await walk(rootTileset.root, new THREE.Matrix4(), rootBase);

  console.log(`[PLATEAU] collected ${leaves.length} content tile(s) for the bbox`);
  if (leaves.length === 0) {
    onProgress && onProgress(1, 'PLATEAU: bbox 範囲に該当タイル無し');
    return null;
  }

  // Decompose the ECEF→local matrix into position/quaternion/scale so we
  // can keep matrixAutoUpdate = true and let the renderer's normal
  // matrixWorld pipeline handle it. Same trick for per-tile transforms.
  const ecefToLocal = buildEcefToLocalMatrix(bb);
  const group = new THREE.Group();
  group.name = 'plateau';
  ecefToLocal.decompose(group.position, group.quaternion, group.scale);

  // GLTFLoader + DRACOLoader. PLATEAU's LOD2 glb tiles use Draco mesh
  // compression — without this every loader.parse() throws "No DRACOLoader
  // instance provided" and we render nothing. The DRACOLoader is a
  // module-level singleton: each instance spins up a decoder worker pool
  // that is never disposed, so a fresh one per run leaked workers on
  // every regenerate.
  const loader = new THREE.GLTFLoader();
  if (typeof THREE.DRACOLoader === 'function') {
    if (!loadPlateauBuildings._draco) {
      const draco = new THREE.DRACOLoader();
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/');
      draco.setDecoderConfig({ type: 'js' });   // wasm decoder needs CORS+headers we don't have; js works everywhere
      loadPlateauBuildings._draco = draco;
    }
    loader.setDRACOLoader(loadPlateauBuildings._draco);
  } else {
    console.warn('[PLATEAU] DRACOLoader script not loaded — LOD2 tiles will fail');
  }
  let done = 0;
  const CONCURRENCY = 6;

  async function loadOne(leaf) {
    try {
      const buffer = await fetch(leaf.url).then(r => r.arrayBuffer());
      // Content can be b3dm (28-byte header + glb) or a bare .glb. Detect
      // by magic: "b3dm" → strip header, "glTF" → use as-is.
      const magic = String.fromCharCode(
        new DataView(buffer).getUint8(0), new DataView(buffer).getUint8(1),
        new DataView(buffer).getUint8(2), new DataView(buffer).getUint8(3));
      let glb, rtcCenter = null;
      if (magic === 'b3dm') {
        const parsed = parseB3dm(buffer);
        glb = parsed.glb;
        rtcCenter = parsed.rtcCenter;     // ECEF metres
      } else {
        glb = buffer;
      }
      // glTF can also carry the centre via CESIUM_RTC extension; check
      // there if the b3dm feature table didn't have it.
      if (!rtcCenter) rtcCenter = readGlbCesiumRtcCenter(glb);

      // FALLBACK ANCHOR. If we still have no RTC_CENTER and leaf.transform
      // is identity, the b3dm gave us no spatial info at all — small
      // RTC-relative vertices would land near the ECEF ORIGIN (Earth's
      // centre) instead of at the city. Use the tile's region centroid
      // (always present in PLATEAU tilesets) converted to ECEF as a
      // substitute anchor. (Skipped below if the vertices turn out to be
      // absolute ECEF — see the verticesAbsolute guard.)
      let anchorSource = rtcCenter ? 'rtc' : null;
      if (!rtcCenter && leaf.region) {
        const lon = (leaf.region[0] + leaf.region[2]) / 2 * 180 / Math.PI;
        const lat = (leaf.region[1] + leaf.region[3]) / 2 * 180 / Math.PI;
        const h   = (leaf.region[4] + leaf.region[5]) / 2;
        const c   = geodeticToEcef(lat, lon, h);
        rtcCenter = [c.x, c.y, c.z];
        anchorSource = 'region';
      }
      if (!rtcCenter) anchorSource = 'NONE';

      // GLTFLoader needs a resource path for any EXTERNAL textures/bins the
      // glb references relatively (PLATEAU textured tiles often do).
      const resPath = leaf.url.substring(0, leaf.url.lastIndexOf('/') + 1);
      const gltf = await new Promise((resolve, reject) => {
        loader.parse(glb, resPath, resolve, reject);
      });
      // Per-tile transform: glTF vertex → ECEF. PLATEAU follows the
      // 3D Tiles 1.0 spec: glb vertices are ECEF-relative-to-RTC_CENTER
      // with the axes swapped to glTF Y-up (gltf = (x, z, -y) of the
      // ECEF vector). So the runtime transform is
      //     ecef = leaf.transform · translate(RTC_CENTER) · rotX(+90°) · v
      // — rotX undoes the axis swap, the translation restores the
      // anchor.
      //
      // DO NOT replace rotX with an ENU-at-RTC_CENTER basis matrix.
      // That assumes vertices are stored in a LOCAL east/up/south frame,
      // which PLATEAU does not do; numerically a 100 m vertical edge
      // comes out (−61.9, 58.3, −52.5) instead of (0, 100, 0) — every
      // building tilts ~54° at Tokyo's latitude. (Tried in 577ccd6,
      // reverted here. The giveaway: Tokyo Station rendered upright
      // under rotX, which is impossible if rotX itself were wrong.)
      //
      // Guard: a tile with vertices in ABSOLUTE ECEF (huge coordinates,
      // no baked anchor) must not get the anchor translation added on
      // top — that would displace it by another Earth radius.
      const rawBox = new THREE.Box3().setFromObject(gltf.scene);
      const rawMagnitude = isFinite(rawBox.min.x)
        ? rawBox.getCenter(new THREE.Vector3()).length() : 0;
      const verticesAbsolute = rawMagnitude > 1e5;
      const UP_AXIS = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      const tileXform = leaf.transform.clone();
      if (rtcCenter && !verticesAbsolute) {
        tileXform.multiply(
          new THREE.Matrix4().makeTranslation(rtcCenter[0], rtcCenter[1], rtcCenter[2])
        );
      }
      tileXform.multiply(UP_AXIS);
      if (leaf._idx < 3) {
        console.log(`[PLATEAU] tile#${leaf._idx} anchor=${anchorSource} ` +
          `absVerts=${verticesAbsolute} ` +
          `RTC=${rtcCenter ? rtcCenter.map(n => n.toFixed(0)).join(',') : 'none'} ` +
          `leaf.transform.identity=${leaf.transform.equals(new THREE.Matrix4())}`);
      }
      tileXform.decompose(gltf.scene.position, gltf.scene.quaternion, gltf.scene.scale);
      // Replace PBR with Phong so PLATEAU buildings sit in the same flat-
      // shaded cartoon look as OSM but DON'T lose their detail maps the
      // way Lambert did. MeshPhongMaterial supports map + normalMap +
      // specularMap — and PLATEAU's textured LOD2 tiles carry both diffuse
      // and (often) normal maps that give roofs their tiled / shingled
      // look in the official viewer. The previous Lambert swap silently
      // dropped normalMap and that was the missing roof detail.
      let leafTextured = 0, leafTotal = 0;
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        leafTotal++;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map(m => {
          if (!m) return m;
          if (m.map) leafTextured++;
          // CRITICAL: when there's a diffuse texture, force the material's
          // base colour to white. PLATEAU's source materials sometimes set
          // colour to a dim grey that gets MULTIPLIED with the texture,
          // making photo textures look murky / dark. White = texture
          // passes through unmodified.
          //
          // No texture (no-texture LOD2 variants — most of Osaka, and many
          // regional cities, ship LOD2 without photo textures): stark
          // white reads as "missing data". Tint with a soft per-mesh tone
          // from the cartoon palette instead, deterministic by mesh count
          // so re-runs look identical.
          let color;
          if (m.map) {
            color = new THREE.Color(0xffffff);
          } else {
            const PALETTE = [0xeae4d8, 0xe3dcd2, 0xefe8da, 0xe0d8cc, 0xe8e2d4, 0xdcd6c8];
            color = new THREE.Color(PALETTE[leafTotal % PALETTE.length]);
          }
          const phong = new THREE.MeshPhongMaterial({
            color,
            map:          m.map || null,
            normalMap:    m.normalMap || null,
            specularMap:  m.specularMap || null,
            shininess:    8,        // matte enough to keep cartoon feel
            specular:     new THREE.Color(0x222222),
            side:         m.side || THREE.FrontSide,
            transparent:  !!m.transparent,
            opacity:      m.opacity != null ? m.opacity : 1,
          });
          if (m.map) m.map.encoding = THREE.sRGBEncoding;
          phong.name = m.name || 'plateau';
          // Don't dispose m.map / m.normalMap — phong keeps using them.
          m.dispose();
          return phong;
        });
        o.material = Array.isArray(o.material) ? next : next[0];
      });
      // First few tiles report their texture density so the user can
      // tell from console whether textures actually exist on disk vs.
      // we're rendering a no-texture variant.
      if (leaf._idx < 3 && leafTotal > 0) {
        console.log(`[PLATEAU tile #${leaf._idx}] ${leafTextured}/${leafTotal} meshes carry a diffuse texture`);
      }
      group.add(gltf.scene);
    } catch (e) {
      // Skip individual tile failures; PLATEAU CDN occasionally serves
      // partial responses and one bad tile shouldn't take down the city.
      console.warn('PLATEAU tile failed:', leaf.url, e.message);
    }
    done++;
    onProgress && onProgress(done / leaves.length, `PLATEAU タイル ${done}/${leaves.length}`);
  }

  // Capped concurrency — PLATEAU CDN handles a handful of parallel requests
  // fine but 100+ at once trips its rate limiter.
  const queue = leaves.slice();
  async function pump() {
    while (queue.length) {
      const leaf = queue.shift();
      if (leaf) await loadOne(leaf);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, pump));

  // If every tile failed (CDN down, all b3dm corrupt, etc) the group is
  // empty — return null so app.js falls back to OSM instead of claiming
  // "PLATEAU で表示中" over a blank scene.
  if (group.children.length === 0) {
    console.warn('[PLATEAU] all tiles failed to load — falling back to OSM');
    return null;
  }
  // Report the group's local-space bounds so we can see if buildings land
  // at sane coordinates (a few hundred metres span, Y near ground level)
  // vs. wildly off (transform bug).
  group.updateMatrixWorld(true);
  const dbgBox = new THREE.Box3().setFromObject(group);
  console.log('[PLATEAU] group bounds (local m):',
    'x', dbgBox.min.x.toFixed(0), '→', dbgBox.max.x.toFixed(0),
    '| y', dbgBox.min.y.toFixed(0), '→', dbgBox.max.y.toFixed(0),
    '| z', dbgBox.min.z.toFixed(0), '→', dbgBox.max.z.toFixed(0));
  console.log(`[PLATEAU] rendered ${group.children.length} tile(s)`);
  return group;
}
