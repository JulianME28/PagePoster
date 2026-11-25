"""Create harmless importable training inputs for the illustrated guide."""
from pathlib import Path
import csv, io, zipfile
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs'/'user-guide-examples'
OUT.mkdir(parents=True,exist_ok=True)
rows=[('ua-guide.html','Путівник для мандрівника','UA','putivnyk','#2459ba'),('gb-guide.html','Поради для поїздки','GB','porady-dlia-poizdky','#197568'),('nz-guide.html','Список речей у дорогу','NZ','spysok-rechei','#7b4da6')]
def html(title,color):
 return f'''<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f4f7fc;color:#19304c;font:16px/1.6 Arial,sans-serif}}header{{background:{color};color:white;padding:28px}}main{{max-width:940px;margin:auto;padding:32px 24px}}h1{{font-size:38px;line-height:1.15}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}}article{{background:white;padding:22px;border:1px solid #d7e1ef;border-radius:16px}}a{{display:inline-block;color:white;background:{color};padding:12px 18px;text-decoration:none;border-radius:9px}}footer{{padding:24px;text-align:center}}@media(max-width:600px){{h1{{font-size:28px}}main{{padding:20px}}}}
</style></head><body><header>TRAVEL DEMO · Навчальний приклад PagePoster</header><main><h1>{title}</h1><p>Це навчальна сторінка для знайомства з імпортом та попереднім переглядом. Вона не містить робочих рекламних посилань.</p><div class="cards"><article><h2>План маршруту</h2><p>Визначте напрямок, тривалість та основні зупинки.</p></article><article><h2>Бюджет</h2><p>Заздалегідь врахуйте дорогу, проживання та щоденні витрати.</p></article><article><h2>Підготовка</h2><p>Перевірте документи, бронювання та список необхідних речей.</p></article></div><h2 id="checklist">Перед поїздкою</h2><ul><li>Збережіть копії документів.</li><li>Звірте час виїзду та адресу проживання.</li><li>Перегляньте умови бронювання.</li></ul><a href="https://offer.example/travel?ref=training">Навчальне посилання</a><p>Адреса example використана лише як приклад.</p></main><footer>TRAVEL DEMO · Тестовий матеріал</footer></body></html>'''
buf=io.StringIO(newline='')
w=csv.writer(buf,lineterminator='\n')
w.writerow(['file','slug','language','geo'])
for filename,title,geo,slug,color in rows:w.writerow(['pages/'+filename,slug,'uk',geo])
with zipfile.ZipFile(OUT/'02-html-project.zip','w',zipfile.ZIP_DEFLATED) as archive:
 archive.writestr('plan.csv',buf.getvalue().encode('utf-8-sig'))
 for filename,title,geo,slug,color in rows:archive.writestr('pages/'+filename,html(title,color).encode('utf-8'))
buf=io.StringIO(newline='')
w=csv.writer(buf,lineterminator='\n')
w.writerow(['key','title','url','anchor','url2','anchor2','cardCount','language','geo','format','topic','customTopic'])
w.writerow(['demo-1','Travel planning guide','https://offer.example/travel?ref=training','travel planning guide','https://tips.example/travel','travel checklist',4,'en','GB','guide','custom','How to plan a short trip'])
(OUT/'01-ai-project.csv').write_text(buf.getvalue(),encoding='utf-8-sig',newline='')
(OUT/'README.txt').write_text('НАВЧАЛЬНІ ПРИКЛАДИ PAGEPOSTER\n\n02-html-project.zip: три готові HTML-сторінки, таблиця зі slug, мовою та GEO. Завантажте ZIP через «Імпорт проєкту». Донорів у прикладі не задано: виберіть власні дозволені сайти перед публікацією.\n\n01-ai-project.csv: один рядок для генерації англійською з двома парами посилань і чотирма картками (cardCount). Після імпорту підготовка використовує підключений OpenAI API. Адреси example навчальні. Замініть їх своїми робочими посиланнями перед реальним використанням.\n\nДля першого знайомства почніть із готового HTML ZIP.\n',encoding='utf-8')
buf=io.StringIO(newline='')
w=csv.writer(buf,lineterminator='\n')
w.writerow(['ID','Домен','Примітка','DR','Трафік','Гео','Категорія','Регіон','Стан','Опис','Логін','Пароль','Додатково','Другий логін','Другий пароль'])
w.writerow(['demo-1','https://your-site.example/','','40','1000','UA','','','','','YOUR_LOGIN','YOUR_PASSWORD','','',''])
(OUT/'03-donor-base-template.csv').write_text(buf.getvalue(),encoding='utf-8-sig',newline='')
with (OUT/'README.txt').open('a',encoding='utf-8') as file:
 file.write('\n03-donor-base-template.csv: шаблон бази сайтів для Google Таблиць, не для імпорту сторінок у PagePoster. Збережено схему A–O: домен у B, DR у D, трафік у E, GEO у F, логін і пароль у K/L, другий доступ у N/O. Замініть навчальні домен і доступи своїми перед використанням.\n')
dest=ROOT.parent/'deliverables'/'PagePoster-Guide-Examples.zip'
with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as archive:
 for file in sorted(OUT.iterdir()):archive.write(file,file.name)
print(dest)

