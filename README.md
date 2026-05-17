# Satoshi Market Archive

사토시마켓을 정적 박물관 형태로 보존한 아카이브입니다.

## 보기

```bash
cd satoshi-market-archive
python3 -m http.server 4173
```

브라우저에서 `http://localhost:4173/`를 엽니다. 실제 아카이브는 `/ecommerce/` 경로에 있고, 루트 `index.html`은 `/ecommerce/`로 이동시킵니다.

## 구성

- `index.html`: `/ecommerce/`로 이동시키는 루트 페이지
- `CNAME`: GitHub Pages custom domain 설정용 파일
- `.nojekyll`: GitHub Pages가 정적 파일을 그대로 서빙하도록 하는 파일
- `ecommerce/index.html`: 박물관형 정적 웹사이트
- `ecommerce/styles.css`: 레이아웃과 전시 스타일
- `ecommerce/archive-data.json`: 원본 WordPress API에서 가져온 페이지/상품 메타데이터
- `ecommerce/assets/`: 내려받은 이미지와 누락 이미지 placeholder
- `scripts/build-archive.mjs`: 원본 사이트에서 정적 아카이브를 재생성하는 스크립트

## 다시 생성하기

```bash
node scripts/build-archive.mjs
```

원본 이미지 중 서버에서 404가 나거나 너무 오래 걸리는 파일은 `assets/missing.svg`로 대체됩니다.

## 저비용 운영

이 폴더는 서버나 데이터베이스 없이 동작합니다. GitHub Pages에 그대로 배포하면 WooCommerce, WordPress, DB 서버를 유지하지 않고도 기록을 보존할 수 있습니다.

원본 쇼핑 기능은 비활성화되어 있으며, 결제/장바구니/주문 접수용 사이트로 사용하지 않습니다.

## GitHub Pages 설정

1. GitHub에 public repository를 만듭니다. 권장 이름: `satoshi-market-archive`
2. 이 폴더의 파일을 repository 루트에 업로드합니다.
3. Repository Settings > Pages에서 source를 `Deploy from a branch`, branch를 `main`, folder를 `/ (root)`로 설정합니다.
4. Custom domain에 `satoshimarket.biz`를 입력합니다.
5. DNS에서 apex domain을 GitHub Pages IP로 연결합니다.
6. GitHub Pages에서 `Enforce HTTPS`를 켭니다.
