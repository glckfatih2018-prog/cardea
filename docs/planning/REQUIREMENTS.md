# Cardea gereksinimleri

## Kapsam ve kaynak önceliği

Kaynak SOW'un 13 Eylül 2026 tarihli dokuz ekran görüntüsüdür: §3 hedef, §4.1 teslimatlar/kapsam dışı, §4.2 bütçe, haftalık çalışma tablosu ve §6.1 kanıtlar. Görüntülerde bulunmayan sözleşme hükümleri varsayılmadı. Sonraki proje kararı teslim tarihini 30 Eylül 2026, geliştirme hesabını Foreveranka ve son yayın hesabını glckfatih2018-prog olarak belirliyor.

Aşağıdaki R maddeleri teslimat gereksinimidir. Uygulama planındaki A kararları, bunları gerçekleştirmek için önerilen mühendislik seçimleridir; SOW'a ek bütçe veya yeni ürün vaadi değildir. T numaraları [test matrisine](TEST-MATRIX.md) bağlanır. Durum: gereksinimler tanımlandı, kabul kanıtları henüz toplanmadı.

## D1 — İşlem motoru ve güvenlik · 2.500 dolar

| ID | Zorunlu sonuç | Kabul kanıtı / test |
|---|---|---|
| R01 | Yalnız Stellar testnet üzerinde çalışma; arayüz ve konfigürasyonda ağ açık | Yanlış ağda imza/gönderim reddi; T06, T49 |
| R02 | Alıcının zincirde henüz olmayan adresi için hesabı oluşturma; başlangıç XLM bakiyesi sıfır | Önce hesap yok, sonra native balance 0; T01 |
| R03 | Tam olarak belirlenen testnet USDC trustline'ı oluşturma | Kod+issuer ve sponsor alanlarının zincir doğrulaması; T01, T03 |
| R04 | Hesap ve trustline aynı atomik dört operasyonlu sponsorluk işlemiyle açılır | Operasyon sırası/source/startingBalance doğrulaması; T01, T04, T07 |
| R05 | CAP-15 fee-bump sayesinde alıcı ağ ücretini ödemez | İç/dış işlem, fee source, fee_charged kaydı; T01, T08 |
| R06 | Alıcı hesabının tek imza yetkilisi alıcıdır; sponsor ek signer değildir | signers/thresholds snapshot; T01, T04 |
| R07 | İstemcinin değiştirdiği işlem gövdesi sponsor imzası almadan reddedilir | İşlem alanlarını tek tek değiştiren testler; T02–T07 |
| R08 | Doğru gövdedeki alıcı imzası gerçekten doğrulanır; yanlış/eksik/ek imzalar kontrol edilir | T05–T06; yalnız signature hint'e güvenilmez |
| R09 | Channel accounts sayesinde 10 eşzamanlı onboarding sequence çakışmadan tamamlanır | 10 farklı alıcı, kanal/sequence/tx hash tablosu; T10–T13 |
| R10 | Replay, eşzamanlı talepler ve ücret suistimali engellenir | T09, T12–T16, T23, T28; mükerrer taahhüt ve sınırsız fee yok |
| R11 | Motor ve negatif senaryolar otomatik testlerle tekrar üretilebilir | Çıkış kodları doğru test komutu, sabit bağımlılıklar; T47 |
| R12 | Gerçek para çıkışı yalnız ağ ücreti; rezerv transfer edilmeyip kilitlenir | Hazırlık fonlaması hariç onboarding öncesi/sonrası bakiye ve reserve units; T01, T19 |

R07'de eşit tutulacak veri **imzalanan işlem gövdesidir**. İmza eklenmiş zarfın tamamını imzasız zarfla eşitlemek geçerli işlemi reddeder. Bu yorum güvenlik şartını gevşetmez; imza kısmı ayrıca kriptografik olarak doğrulanır.

## D2 — Kurum ve havuz işletimi · 1.500 dolar

| ID | Zorunlu sonuç | Kabul kanıtı / test |
|---|---|---|
| R13 | Kurum yetkilisi havuz oluşturabilir ve sponsor hesabına fon sağlayabilir | Uygulama demosu, public hesap eşlemesi ve fonlama durumu; T17, T24 |
| R14 | Adres izin listesi yüklenir; 50 adreslik örnek çalışır | Import raporu ve demo; T18 |
| R15 | Listede olmayan alıcı reddedilir | API ve arayüz testi; T17 |
| R16 | Havuz bazında limit uygulanır; eşzamanlı ve bekleyen imzalar limiti aşamaz | T19–T20; committed+pending toplamı limit içinde |
| R17 | Her alıcıya ayrılan rezerv ve havuz toplamı görünür | Ledger kayıtlarıyla uyuşan rapor; T19, T27 |
| R18 | Yetkili yeni sponsorlukları durdurabilir | Yeni hazırlama/henüz imzalanmamış gönderim reddi; mevcut sponsorlu hesap etkilenmez; T21 |
| R19 | Sponsorun sponsoring sayacı sürekli izlenir | Periyodik worker ve ledger bazlı kontrol; T22, T26 |
| R20 | Açıklanamayan sapmada yeni sponsorluk otomatik durur | Sapma enjeksiyonu, audit event ve pause nedeni; T22 |
| R21 | Kurum işlemleri yetkilendirilmiştir; alıcı yönetim yetkisine ulaşamaz | T24–T25; secret'lar tarayıcıya gönderilmez |
| R22 | Başarısız/yarım kalan işlemler rezerv muhasebesini bozamaz | Restart, timeout, rollback ve dış değişiklik testleri; T11, T13, T26–T29 |

50 adres demonstrasyon büyüklüğüdür, SOW'un zorunlu ürün üst sınırı değildir. `num_sponsoring` insan sayısı değildir; bu akışta bir yeni alıcı üç rezerv birimi oluşturur. Havuzu pause etmek zincire verilmiş imzayı geri alamaz; arayüz henüz sonuçlanmamış işlemleri ayrıca gösterir.

## D3 — Alıcı deneyimi ve rezerv yaşam döngüsü · 1.000 dolar

| ID | Zorunlu sonuç | Kabul kanıtı / test |
|---|---|---|
| R23 | Tek davet bağlantısından cüzdan bağlama ve tek alıcı işlem imzası | Gerçek cüzdan videosu; T37 |
| R24 | Alıcının özel anahtarı/seed'i alınmaz; ürün alıcı adına cüzdan üretmez | Browser/API/log kontrolü; T44; test fixture anahtarları ürün dışıdır |
| R25 | Alıcı başarı durumunu ve açık hesabını görebilir | Zincir teyidinden sonra başarı, bağlantılı işlem; T40 |
| R26 | Yeterli kendi XLM'i bulunan alıcının rezerv sponsorluğu otomatik çözülür | Worker kaynaklı graduation hash ve önce/sonra ledger; T30–T33 |
| R27 | Alıcı hâlâ sıfır XLM'deyken zorla rezerv kaldırılmaz | Ledger reddi ve worker'ın güvenli davranışı; T31 |
| R28 | Sponsor A'dan B'ye devir alıcı imzası/anahtarı olmadan yapılır | A/B onayı, handover hash, alıcı signers sabit; T34–T36 |
| R29 | Kod açık kaynak ve herkese erişilebilir depoda bulunur | Seçilen release commit, MIT dosyaları, secret taraması; T47 |
| R30 | Kurulum, güvenlik modeli, API entegrasyonu ve örnekler belgelenir | Temiz ortamda dokümanla kurulum; T47 |
| R31 | Ürün ve dokümantasyon yayınlanır, D2 demosu erişilebilir | Canlı site, `/docs`, video ve kanıt dizini; T41, T48 |
| R32 | Graduation/devir kanıtı sponsor rezerv değişimini gösterir | İzole fixture'da 3→0; devirde A−3/B+3; T30, T34 |

“Tek imza” alıcıya aittir. Kanal, sponsor ve fee payer'ın servis tarafında imza üretmesi bu şartla çelişmez. Cüzdan bağlama izni ile finansal işlem imzası ayrı etkileşimlerdir. Kullanıcıya ikinci bir login imzası dayatılmayacak.

## Proje kararları ve teslim sınırı

| ID | Gereksinim | Kabul |
|---|---|---|
| R33 | Çalışma Foreveranka tarafında; tamamlanmış sürüm Fatih hesabında yayınlanır | Aynı doğrulanmış commit/ağaç, temiz klon testi; T48 |
| R34 | Kök URL tanıtım sayfasıdır; uygulamaya belirgin giriş vardır | `/`, `/app`, `/onboard/:token` ayrımı; T41 |
| R35 | Teslimat 30 Eylül'e kadar üç kanıt paketiyle hazırlanır | [Takvim](IMPLEMENTATION-PLAN.md); tamamlanmamış madde gizlenmez |
| R36 | Yalnız SOW kapsamı: testnet, USDC, self-host; kullanıcı fonlarına dokunmama | T44, T49–T50; özellik listesi ve dağıtım kontrolü |

## Kapsam dışında kalanlar

Mainnet dağıtımı; Soroban sözleşmeleri; USDC dışı varlıklar; alıcı anahtar saklama veya cüzdan üretme; hosted multitenant hizmet; ödeme/maaş/USDC gönderme ürünü. $5.000 kapsamında pazarlama, bağımsız audit, yeni altyapı veya mainnet maliyeti taahhüt edilmedi.

Kurumun kendi sponsor hesabını fonlaması D2'nin parçasıdır. Graduation testinde izole test alıcısına test XLM gönderilmesi test düzeneğidir; uygulamaya alıcı bakiyesi taşıma yetkisi kazandırmaz. Bir kurumun birden fazla havuzu olabilir; bunun için SaaS tenant yönetimi inşa edilmeyecek.

## Teslimat kabul kuralı

Kod mevcut olması, konsolda “success” yazması veya güzel bir site tek başına yeterli değildir. D1 için testnet işlem+assertion, D2 için çalışan yönetim akışı+negatif demo, D3 için gerçek cüzdan akışı+graduation/devir hash'leri birlikte gereklidir. Kanıtlar release commit, ağ, ledger, tarih ve test çıktılarıyla birbirine bağlanacak.
