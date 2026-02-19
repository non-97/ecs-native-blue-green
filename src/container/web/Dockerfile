FROM nginx:stable-alpine

# ECS Exec のログ出力用に script をインストール
RUN apk add --no-cache util-linux

COPY ./html/ /usr/share/nginx/html/
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
