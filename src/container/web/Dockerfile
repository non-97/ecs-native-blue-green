FROM nginx:stable-alpine

# scriptをインストール
RUN apk add --no-cache util-linux

COPY ./html/ /usr/share/nginx/html/
COPY ./conf/default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
