"""Build the illustrated Ukrainian guide and a text/layout verification manifest."""
from pathlib import Path
import re, html, json, math
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle, Preformatted
from reportlab.pdfbase.pdfdoc import PDFString
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'docs/USER-GUIDE.uk.md'
VERSION='1.1.1'
OUT=ROOT.parent/f'deliverables/PagePoster-User-Guide-{VERSION}-UA.pdf'
QA=ROOT/f'.desktop-build/guide-ua/v{VERSION}'
QA.mkdir(parents=True,exist_ok=True)
for name,file in [('Segoe','segoeui.ttf'),('Segoe-Bold','segoeuib.ttf'),('Mono','consola.ttf')]:
 pdfmetrics.registerFont(TTFont(name,str(Path('C:/Windows/Fonts')/file)))
pdfmetrics.registerFontFamily('Segoe',normal='Segoe',bold='Segoe-Bold')
INK=colors.HexColor('#17314f'); BLUE=colors.HexColor('#2459ba')
styles={
 'body':ParagraphStyle('Body',fontName='Segoe',fontSize=10.4,leading=14.5,textColor=INK,spaceAfter=7),
 'list':ParagraphStyle('List',fontName='Segoe',fontSize=10.4,leading=14.5,textColor=INK,leftIndent=13,firstLineIndent=-13,spaceAfter=6),
 'small':ParagraphStyle('Small',fontName='Segoe',fontSize=8.5,leading=11.6,textColor=colors.HexColor('#566b83')),
 'cell':ParagraphStyle('Cell',fontName='Segoe',fontSize=9.7,leading=13.3,textColor=INK),
 'callout':ParagraphStyle('Callout',fontName='Segoe',fontSize=10.2,leading=14.2,textColor=INK),
 'title':ParagraphStyle('Title',fontName='Segoe-Bold',fontSize=21,leading=26,textColor=INK,spaceAfter=11),
 'code':ParagraphStyle('Code',fontName='Mono',fontSize=9,leading=12,textColor=INK,leftIndent=10),
}
def rich(text):
 escaped=html.escape(text)
 escaped=re.sub(r'\*\*(.+?)\*\*',r'<b>\1</b>',escaped)
 return escaped
def blocks(text):
 lines=text.strip().splitlines();out=[];i=0
 while i<len(lines):
  line=lines[i].strip()
  if not line:i+=1;continue
  fig=re.match(r'!\[(.*?)\]\((.*?)\)',line)
  if fig:out.append(('image',(fig[1],ROOT/'docs'/fig[2])));i+=1;continue
  if line.startswith('~~~'):
   i+=1;code=[]
   while i<len(lines) and not lines[i].startswith('~~~'):code.append(lines[i]);i+=1
   out.append(('code','\n'.join(code)));i+=1;continue
  if line.startswith('|'):
   rows=[]
   while i<len(lines) and lines[i].strip().startswith('|'):
    cells=[x.strip() for x in lines[i].strip().strip('|').split('|')]
    if not all(re.match(r'^:?-+:?$',x) for x in cells):rows.append(cells)
    i+=1
   out.append(('table',rows));continue
  if line.startswith('> '):
   out.append(('callout',line[2:]));i+=1;continue
  if line.startswith('- '):out.append(('list','• '+line[2:]));i+=1;continue
  if re.match(r'^\d+\.',line):out.append(('list',line));i+=1;continue
  para=[line];i+=1
  while i<len(lines) and lines[i].strip() and not re.match(r'^(?:!\[|> |[-] |\d+\.|~~~|\|)',lines[i].strip()):
   para.append(lines[i].strip());i+=1
  out.append(('body',' '.join(para)))
 return out
def flow(block,width):
 kind,value=block
 if kind=='table':
  n=len(value[0]);weights=[.30,.70] if n==2 else [1/n]*n
  rows=[[Paragraph(('<b>'+rich(c)+'</b>') if r==0 else rich(c),styles['cell']) for c in row] for r,row in enumerate(value)]
  t=Table(rows,colWidths=[width*w for w in weights],hAlign='LEFT')
  t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eaf1fc')),('BACKGROUND',(0,1),(-1,-1),colors.HexColor('#fbfcfe')),('GRID',(0,0),(-1,-1),.5,colors.HexColor('#d5dfec')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
  return t,10
 if kind=='callout':
  t=Table([[Paragraph(rich(value),styles['callout'])]],colWidths=[width])
  t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#eff5ff')),('BOX',(0,0),(-1,-1),.6,colors.HexColor('#cdddf6')),('LEFTPADDING',(0,0),(-1,-1),11),('RIGHTPADDING',(0,0),(-1,-1),11),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
  return t,10
 if kind=='code':return Preformatted(value,styles['code']),10
 return Paragraph(rich(value),styles[kind]),styles[kind].spaceAfter

text=SOURCE.read_text(encoding='utf-8-sig')
sections=[]
for part in re.split(r'^## ',text,flags=re.M)[1:]:
 title,body=part.split('\n',1);number=int(title.split('.')[0])
 sections.append((number,title,blocks(body)))
assert len(sections)==21
c=canvas.Canvas(str(OUT),pagesize=A4,pageCompression=1)
c.setTitle(f'PagePoster Desktop {VERSION} — гайд користувача українською')
c.setAuthor('PagePoster');c.setSubject('Налаштування, імпорт, публікація та ручна перевірка сторінок')
c._doc.Catalog.Lang=PDFString('uk-UA')
report=[];page_number=0;chapter_pages={}
M=40
def start_page(number,title,size,figure=False):
 global page_number
 page_number+=1;c.setPageSize(size);w,h=size
 c.setFillColor(BLUE);c.rect(0,h-8,w,8,fill=1,stroke=0)
 c.setFont('Segoe-Bold',8.5);c.drawString(M,h-30,'PAGEPOSTER  /  ГАЙД КОРИСТУВАЧА')
 c.setFont('Segoe',8);c.setFillColor(colors.HexColor('#65788e'));c.drawRightString(w-M,h-30,f'Український інтерфейс · {VERSION}')
 c.setStrokeColor(colors.HexColor('#d5dfec'));c.line(M,29,w-M,29)
 c.setFont('Segoe',8);c.drawString(M,17,'Навчальні приклади · 25.11.2026');c.drawRightString(w-M,17,str(page_number))
 header=Paragraph(('Ілюстрація · ' if figure else '')+rich(title),styles['title'])
 _,hh=header.wrap(w-2*M,200);header.drawOn(c,M,h-51-hh)
 report.append({'page':page_number,'chapter':number,'title':title,'figure':figure,'width':w,'height':h,'images':[]})
 if number not in chapter_pages:
  c.bookmarkPage('chapter-'+str(number));c.addOutlineEntry(title,'chapter-'+str(number),0,False)
 chapter_pages.setdefault(number,page_number)
 return w,h,h-51-hh-12
def put(f,width,y,space):
 _,fh=f.wrap(width,2000);f.drawOn(c,M,y-fh);return y-fh-space
def figure(caption,file,w,h,y,max_height=None):
 iw,ih=Image.open(file).size;cap=Paragraph(rich(caption),styles['small']);_,ch=cap.wrap(w-2*M,100)
 available=(y-42-ch-9) if max_height is None else min(max_height,y-42-ch-9)
 scale=min((w-2*M)/iw,available/ih,1)
 if scale<=0:raise RuntimeError('No room for '+str(file))
 dw,dh=iw*scale,ih*scale;x=(w-dw)/2
 c.setStrokeColor(colors.HexColor('#dae2ef'));c.rect(x-.5,y-dh-.5,dw+1,dh+1,stroke=1,fill=0)
 c.drawImage(str(file),x,y-dh,dw,dh,preserveAspectRatio=True,mask='auto')
 cap.drawOn(c,M,y-dh-8-ch)
 report[-1]['images'].append({'file':file.name,'scale':round(scale,3),'renderedWidth':round(dw,1),'renderedHeight':round(dh,1)})
 return y-dh-8-ch-12
landscape_chapters={2,7,10,13,14,17,19}
for number,title,items in sections:
 size=landscape(A4) if number in landscape_chapters else A4
 w,h,y=start_page(number,title,size);width=w-2*M
 ordinary=[b for b in items if b[0]!='image'];pictures=[b[1] for b in items if b[0]=='image']
 total=0
 for b in ordinary:
  f,space=flow(b,width);_,fh=f.wrap(width,2000);total+=fh+space
 # Text is kept in natural reading order, with all illustrations following its instructions.
 for b in ordinary:
  f,space=flow(b,width);_,fh=f.wrap(width,2000)
  if y-fh<42:
   c.showPage();w,h,y=start_page(number,title+' (продовження)',size);width=w-2*M
  y=put(f,width,y,space)
 for caption,file in pictures:
  assert file.is_file(),file
  iw,ih=Image.open(file).size
  native=min(width/iw,1);preferred=ih*native
  cap=Paragraph(rich(caption),styles['small']);_,ch=cap.wrap(width,100)
  available=y-42-ch-21
  minimum=.65 if iw<=600 else .78
  if available>=preferred*minimum:
   y=figure(caption,file,w,h,y)
  else:
   c.showPage();figsize=landscape(A4) if iw/ih>1.28 else A4
   w,h,y=start_page(number,title,figsize,True);width=w-2*M
   y=figure(caption,file,w,h,y)
 c.showPage()
c.save()
reader=PdfReader(str(OUT));assert len(reader.pages)==page_number
all_text='\n'.join(p.extract_text() or '' for p in reader.pages)
for phrase in ('OpenAI API-ключ','Створити проєкт','Схвалити','Звірити кошик','Імпортувати реєстрацію','Кількість карток','Продовжити відкладену сторінку','Повторити додавання до черги'):
 assert phrase in ' '.join(all_text.split()),phrase
assert not re.search(r'[ыэъёЫЭЪЁ]',all_text),'Russian text found'
assert not any(p.get('/Annots') for p in reader.pages),'Unexpected hyperlink annotations'
assert '\u25a0' not in all_text
(QA/'layout.json').write_text(json.dumps({'pages':page_number,'chapters':len(sections),'chapterPages':chapter_pages,'layouts':report},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'pdf':str(OUT),'pages':page_number,'chapters':len(sections),'figures':sum(len(p['images']) for p in report),'hyperlinks':0},ensure_ascii=False))

