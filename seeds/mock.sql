-- Mock өгөгдөл (зөвхөн локал / testing): `npm run db:seed:local`, `npm run db:seed:testing`
-- Давтан ажиллуулахад аюулгүй — mock хүснэгтүүдийг хоослоод дахин бөглөнө.
-- migrations/-д биш тул production-д хэзээ ч орохгүй.

DELETE FROM mock_listing_images;
DELETE FROM mock_listings;
DELETE FROM mock_agents;
DELETE FROM sqlite_sequence WHERE name IN ('mock_agents', 'mock_listings', 'mock_listing_images');

INSERT INTO mock_agents (id, name, email, phone, role, created_at) VALUES
  (1, 'Бат-Эрдэнэ', 'admin@example.com',  '99110001', 'admin', unixepoch() - 90 * 86400),
  (2, 'Сарангэрэл', 'saraa@example.com',  '88220002', 'agent', unixepoch() - 80 * 86400),
  (3, 'Тэмүүлэн',   'temuu@example.com',  '95330003', 'agent', unixepoch() - 60 * 86400),
  (4, 'Нандин',     'nandin@example.com', '99440004', 'agent', unixepoch() - 45 * 86400),
  (5, 'Ганзориг',   'gana@example.com',   '80550005', 'agent', unixepoch() - 30 * 86400);

INSERT INTO mock_listings
  (id, agent_id, title, description, deal_type, category, district, price, area, rooms, floor, status, views, created_at)
VALUES
  (1,  2, '3 өрөө байр, Зайсан',            'Шинэ барилга, тавилгатай, хотын үзэмжтэй.',        'sale', 'apartment', 'Хан-Уул',        480000000, 98.5,  3, 12,   'active',  412, unixepoch() -  2 * 86400),
  (2,  2, '2 өрөө байр, 13-р хороолол',     'Сургууль, цэцэрлэгт ойрхон.',                      'sale', 'apartment', 'Баянзүрх',       210000000, 56.0,  2, 5,    'active',  238, unixepoch() -  3 * 86400),
  (3,  3, '1 өрөө түрээс, Их тойруу',       'Сарын түрээс, ус дулаан орсон.',                   'rent', 'apartment', 'Сүхбаатар',        1800000, 38.0,  1, 7,    'active',  651, unixepoch() -  1 * 86400),
  (4,  3, '4 өрөө пентхаус, Сансар',        'Хоёр давхар, дээврийн тагттай.',                   'sale', 'apartment', 'Баянзүрх',       920000000, 186.0, 4, 16,   'active',  889, unixepoch() -  5 * 86400),
  (5,  4, 'Хашаа байшин, Яармаг',           '0.07 га газартай, гараажтай.',                      'sale', 'house',     'Хан-Уул',        350000000, 140.0, 5, NULL, 'active',  174, unixepoch() -  8 * 86400),
  (6,  4, 'Газар 0.1 га, Шувуун фабрик',    'Эзэмшлийн гэрчилгээтэй, цахилгаан орсон.',          'sale', 'land',      'Сонгинохайрхан',  95000000, 1000.0, NULL, NULL, 'active', 96, unixepoch() - 12 * 86400),
  (7,  5, 'Оффис түрээс, Төв шуудан',       'Нээлттэй оффис, хурлын өрөөтэй.',                   'rent', 'office',    'Чингэлтэй',        6500000, 120.0, NULL, 3,  'active',  305, unixepoch() -  4 * 86400),
  (8,  5, 'Худалдааны талбай, 3-р хороолол','Нэгдүгээр давхарт, гудамж руу харсан.',             'rent', 'shop',      'Баянгол',          4200000, 65.0,  NULL, 1,  'active',  267, unixepoch() -  6 * 86400),
  (9,  2, 'Дулаан гараж, 120 мянгат',       'Хаалга автомат, хамгаалалттай.',                    'sale', 'garage',    'Баянгол',          28000000, 20.0,  NULL, -1, 'active',   88, unixepoch() - 15 * 86400),
  (10, 3, '2 өрөө түрээс, Хүннү 2222',      'Тавилгатай, гадаад хүнд тохиромжтой.',              'rent', 'apartment', 'Хан-Уул',          2500000, 62.0,  2, 9,    'active',  540, unixepoch() -  2 * 86400),
  (11, 4, '3 өрөө байр, Бөхийн өргөө',      'Засвар хийгдсэн, нарны зүгтэй.',                    'sale', 'apartment', 'Баянзүрх',       265000000, 74.0,  3, 4,    'sold',    720, unixepoch() - 40 * 86400),
  (12, 5, 'Хаус, Нисэх',                    'Хоёр давхар, саунатай, 0.05 га.',                    'sale', 'house',     'Хан-Уул',        680000000, 260.0, 6, NULL, 'active',  318, unixepoch() - 10 * 86400),
  (13, 2, 'Офис зарна, Улаанбаатар зочид буудал', 'Хуулийн фирмд тохиромжтой.',                  'sale', 'office',    'Сүхбаатар',      540000000, 145.0, NULL, 6,  'active',  133, unixepoch() - 18 * 86400),
  (14, 3, '1 өрөө байр, Офицерын',          'Анхны орон сууц, зээлээр авах боломжтой.',          'sale', 'apartment', 'Баянзүрх',       135000000, 36.0,  1, 2,    'active',  402, unixepoch() -  7 * 86400),
  (15, 4, 'Газар 0.5 га, Тэрэлж',           'Зуслан барих зориулалттай.',                         'sale', 'land',      'Налайх',          60000000, 5000.0, NULL, NULL, 'expired', 51, unixepoch() - 75 * 86400),
  (16, 5, 'Лангуу түрээс, Нарантуул',       'Хүн их урсгалтай байршил.',                          'rent', 'shop',      'Баянзүрх',         1500000, 12.0,  NULL, 1,  'active',  199, unixepoch() -  9 * 86400),
  (17, 1, '5 өрөө байр, Ривер гарден',      'Голын эрэг дагуу, 2 машины зогсоолтой.',             'sale', 'apartment', 'Хан-Уул',       1150000000, 210.0, 5, 18,   'active',  967, unixepoch() -  1 * 86400),
  (18, 2, '2 өрөө байр, Дэнжийн 1000',      'Хуучин байр, үнэ тохиролцоно.',                      'sale', 'apartment', 'Чингэлтэй',      155000000, 48.0,  2, 3,    'active',  144, unixepoch() - 20 * 86400),
  (19, 3, '3 өрөө түрээс, Зайсан',          'Урт хугацаагаар түрээслүүлнэ.',                       'rent', 'apartment', 'Хан-Уул',          4800000, 105.0, 3, 11,   'sold',    611, unixepoch() - 33 * 86400),
  (20, NULL,'Гараж, Баянхошуу',             'Агентгүй (эзэмшигчээс шууд).',                        'sale', 'garage',    'Сонгинохайрхан',  12000000, 18.0,  NULL, 0,  'active',   37, unixepoch() - 25 * 86400);

-- Зар бүрт 1–3 зураг (R2 түлхүүр: mock/listings/<id>/<n>.jpg — файл өөрөө bucket-д байхгүй)
INSERT INTO mock_listing_images (listing_id, r2_key, sort_order)
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2)
SELECT l.id, 'mock/listings/' || l.id || '/' || (n.i + 1) || '.jpg', n.i
FROM mock_listings l JOIN n ON n.i < (l.id % 3) + 1
ORDER BY l.id, n.i;
