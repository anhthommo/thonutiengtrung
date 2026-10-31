# Vở tập nói tiếng Trung

Trang học tiếng Trung chạy trên Cloudflare Workers, có 3 nguồn giọng đọc (Edge miễn phí, Azure, ElevenLabs), chọn giọng nam/nữ, đặt giọng mặc định, và thêm câu của riêng bạn (lưu trong Supabase).

## Cấu trúc

- `public/index.html` là trang web. `public/pinyin-pro.js` là thư viện tự tạo pinyin cho câu bạn nhập.
- `src/worker.js` là máy chủ nhỏ: gọi giọng đọc, lưu câu, lưu cài đặt.
- `src/edge-drm.js` là phần tạo mã xác thực cho giọng Edge, viết lại từ thư viện Python `edge-tts` (đã đối chiếu kết quả với bản Python).
- `supabase.sql` tạo bảng và kho lưu âm thanh.
- `wrangler.toml` là cấu hình Cloudflare. Không bắt buộc điền key ở đây; chỉ dùng nếu muốn đặt mật khẩu cho trang.

## Cài đặt (khoảng 10 phút)

1. **Supabase:** mở project, vào SQL Editor, dán toàn bộ `supabase.sql` rồi bấm Run. Bước này chỉ làm một lần.
2. **Đưa lên Cloudflare** (cần cài Node.js trước):
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   Lệnh sẽ in ra địa chỉ dạng `https://hoc-tieng-trung.<tên-bạn>.workers.dev`.
3. **Nhập key ngay trên trang:** mở địa chỉ đó, bấm nút **Kết nối và API key** ở góc trên bên phải, điền những dịch vụ bạn dùng, bấm **Kiểm tra kết nối** rồi **Lưu**.
   - **Supabase:** Project URL và khoá service_role (Project Settings > API).
   - **Azure:** tạo tài nguyên Speech gói Free F0, lấy Key 1 và vùng (ví dụ `southeastasia`).
   - **ElevenLabs:** API key ở Profile > API Keys. Vào Voice Library, lọc ngôn ngữ Chinese, bấm Add vài giọng nam và nữ.

Không cần sửa file nào. Key được lưu trên trình duyệt. Nếu để tích ô đồng bộ, key Azure và ElevenLabs được lưu thêm lên Supabase, nên trên máy khác bạn chỉ cần nhập Supabase là các key còn lại tự điền.

Lưu ý: thư mục `public/` có khoảng 14.400 file (phần lớn là từ điển và dữ liệu nét chữ), vẫn dưới giới hạn 20.000 file của gói Cloudflare miễn phí. Lần deploy đầu sẽ mất vài phút để tải lên.

Muốn chạy thử trên máy trước khi đưa lên mạng, dùng `npx wrangler dev` rồi mở `http://localhost:8787`.

## Tính năng

- Chữ Hán to trong ô 田字格, pinyin tô màu theo thanh điệu (bật/tắt trên thanh công cụ), nghĩa tiếng Việt ẩn, đánh dấu câu đã thuộc.
- 3 nguồn giọng (Edge miễn phí, Azure, ElevenLabs), chọn nam/nữ, đặt giọng mặc định.
- **Phông chữ Khải thư:** dùng LXGW WenKai Lite (giấy phép OFL) nằm sẵn trong `public/fonts/`, nên nét chữ hiển thị giống nhau trên iPhone, Android và máy tính.
- **Tập viết:** nút ✍️ trên mỗi câu (hoặc chọn "Chạm vào chữ để: Tập viết"). Có 3 chế độ: xem thứ tự nét, viết theo nét mờ, tự viết. Trang ghi nhớ số lần sai của từng chữ.
- **Tra từ:** chạm vào chữ to để nghe và mở thẻ tra cứu (chọn "Chạm vào chữ để: Tra từ"). Thẻ gồm:
  - Âm Hán Việt và nghĩa của chữ (hiện đại, kèm nghĩa cổ điển theo Thiều Chửu).
  - Từ trong câu có chứa chữ đó và nghĩa của từ.
  - Các từ ghép thường gặp.
  - Danh sách câu khác có chứa từ hoặc chữ đó, kèm nút đến thẳng câu.
  - Nút thêm từ vào câu của bạn.
  
  Từ điển nằm sẵn trong `public/dict/` (khoảng 14.000 file nhỏ, mỗi chữ một file), không cần mạng hay API.
- **Thêm câu:** tự điền pinyin và tự dịch nghĩa. Dịch dùng Google Dịch miễn phí, hoặc Azure Translator nếu bạn nhập key.
- **Dán nhiều câu một lúc:** mỗi dòng một câu, có thể kèm `| nghĩa` hoặc `| pinyin | nghĩa`.
- **Cài như ứng dụng:**
  - Android/Chrome: bấm nút **📲 Cài ứng dụng**.
  - iPhone: mở bằng Safari, bấm Chia sẻ rồi chọn **Thêm vào MH chính**.
  - Sau khi cài, trang mở được cả khi mất mạng. Câu đã nghe và chữ đã tập viết được lưu lại để dùng offline.

## Cách dùng

- **Chọn giọng:** bấm vào thanh **Giọng đọc** để mở phần chọn nguồn và giọng. Nút **Nữ / Nam** luôn hiện sẵn để đổi nhanh.
- **Đặt mặc định:** bấm **Đặt làm mặc định**. Giọng được lưu vào Supabase nên mở trên điện thoại hay máy tính đều giống nhau.
- **Tra từ:** chạm vào chữ to để nghe và mở thẻ tra cứu (chọn "Chạm vào chữ để: Tra từ"). Thẻ gồm:
  - Âm Hán Việt và nghĩa của chữ (hiện đại, kèm nghĩa cổ điển theo Thiều Chửu).
  - Từ trong câu có chứa chữ đó và nghĩa của từ.
  - Các từ ghép thường gặp.
  - Danh sách câu khác có chứa từ hoặc chữ đó, kèm nút đến thẳng câu.
  - Nút thêm từ vào câu của bạn.
  
  Từ điển nằm sẵn trong `public/dict/` (khoảng 14.000 file nhỏ, mỗi chữ một file), không cần mạng hay API.
- **Thêm câu:** vào tab **＋ Thêm câu của tôi**. Gõ chữ Hán, pinyin sẽ tự điền và bạn có thể sửa. Nhập nghĩa và chủ đề; câu cùng chủ đề sẽ nằm chung một tab. Câu đã lưu có nút **Sửa** và **Xoá**.
- **Âm thanh được lưu lại:** mỗi câu chỉ tốn ký tự Azure/ElevenLabs ở lần đọc đầu tiên. Âm thanh được lưu vào kho `tts-cache` trong Supabase Storage.

## Nhiều key, tự chuyển khi hết hạn mức

Trong **Kết nối và API key**, mỗi dịch vụ Azure Speech, ElevenLabs và Azure Translator đều nhập được nhiều key. Bấm **＋ Thêm key** để thêm dòng mới.

- Trang dùng key đang hoạt động (nhãn "Key n" màu xanh). Khi key đó lỗi, hết hạn mức (lỗi 401, 402, 403, 429) hoặc không có giọng đã chọn, máy chủ tự thử key tiếp theo trong cùng lần đọc. Trang hiện thông báo đã chuyển sang key nào và nhớ key đó cho những lần sau.
- Khi đi hết danh sách, trang quay vòng lại key đầu tiên. Nhờ vậy, key đầu tháng được làm mới hạn mức sẽ tự được dùng lại.
- **Azure Speech:** mỗi key đi kèm vùng (region) của nó, nên có thể trộn key từ nhiều vùng hoặc nhiều tài khoản.
- **ElevenLabs:** mỗi key là một tài khoản. Hãy thêm cùng những giọng vào My Voices của mọi tài khoản; giọng chỉ có ở một số tài khoản sẽ được ghi chú "[chỉ có ở key …]". Nút **Kiểm tra kết nối** cho biết mỗi key còn bao nhiêu ký tự và ngày được làm mới.
- **Azure Translator:** khi mọi key đều không dùng được, trang tự quay về Google Dịch miễn phí.
- Nếu bật đồng bộ, toàn bộ danh sách key được lưu lên Supabase. Máy mới chỉ cần nhập Supabase là có đủ key.
- Có thể đặt sẵn key trong `wrangler.toml`, nhiều key cách nhau bằng dấu phẩy (ví dụ `AZURE_KEY = "key1,key2"`). Các key này được thêm vào cuối danh sách nhập trên trang.

## Cài lên iPhone như một ứng dụng

1. Mở địa chỉ trang (dạng `https://hoc-tieng-trung.<tên-bạn>.workers.dev`) bằng **Safari**.
2. Bấm nút **Chia sẻ** (ô vuông có mũi tên đi lên) rồi chọn **Thêm vào MH chính**. Giữ bật **Mở dưới dạng ứng dụng web** nếu có, rồi bấm **Thêm**.
3. Trên màn hình chính sẽ có biểu tượng chữ 汉. Ứng dụng mở toàn màn hình, không có thanh địa chỉ.
4. **Nhập lại key trong ứng dụng.** iPhone lưu dữ liệu của ứng dụng tách riêng với Safari. Mở ứng dụng, bấm ⚙︎ và nhập Supabase. Nếu trước đó đã bật đồng bộ, key Azure, ElevenLabs và Translator sẽ tự điền.
5. **Dùng khi mất mạng:** chữ, từ điển, tập viết và các câu đã nghe vẫn dùng được. Câu chưa nghe lần nào sẽ đọc bằng giọng có sẵn của iPhone.

Mẹo: nếu nút đọc im lặng, kiểm tra công tắc gạt im lặng bên hông iPhone. Âm thanh trên web bị tắt khi máy ở chế độ im lặng.

## Khi có sự cố

- **Giọng Edge không đọc được:** Microsoft thỉnh thoảng đổi cách xác thực. Xem file `src/edge_tts/constants.py` trên GitHub của dự án `rany2/edge-tts` và cập nhật `EDGE_VERSION` trong `src/worker.js` cho khớp `CHROMIUM_FULL_VERSION`. Nếu họ đổi cả thuật toán thì tạm dùng Azure. Trong lúc lỗi, trang tự chuyển sang giọng của trình duyệt.
- **Azure báo lỗi 401:** sai key hoặc sai vùng (region).
- **Azure báo lỗi 400:** tên giọng không có ở vùng đó; chọn giọng khác.
- **ElevenLabs không có giọng nào:** chưa thêm giọng vào My Voices, hoặc key thiếu quyền đọc giọng (Voices: Read).
- **Muốn chặn người lạ dùng ké:** điền `APP_PASSWORD` trong `wrangler.toml` rồi deploy lại. Trang sẽ hỏi mật khẩu một lần rồi tự nhớ.

## Giấy phép thư viện kèm theo

- `hanzi-writer.min.js`: Hanzi Writer, giấy phép MIT.
- Dữ liệu nét chữ (gộp sẵn vào `public/dict/`): hanzi-writer-data, dựa trên Make Me a Hanzi và phông Arphic, giấy phép Arphic Public License.
- `pinyin-pro.js`: pinyin-pro, giấy phép MIT.
- `public/fonts/`: LXGW WenKai Lite, giấy phép SIL Open Font License (xem `OFL.txt`).
- `public/dict/`: dựng từ
  - CVDICT của Phong Phan (CC BY-SA 4.0, dịch từ CC-CEDICT).
  - Hán Việt tự điển của Thiều Chửu (phạm vi công cộng).
  - Danh sách tần suất từ FrequencyWords của Hermit Dave, dùng để xếp từ ghép thường gặp lên trước.
  
  Phần dữ liệu này giữ giấy phép CC BY-SA 4.0.
