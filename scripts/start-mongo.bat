@echo off
rem 启动本项目专用的 MongoDB（数据目录 D:\MongoDB\survey-data；不使用/修改其他数据目录）
rem 若 27017 已有本项目的 mongod 在运行，再次启动会因锁文件占用而退出（无害）。
if not exist "D:\MongoDB\survey-data" mkdir "D:\MongoDB\survey-data"
mongod --dbpath "D:\MongoDB\survey-data" --port 27017 --bind_ip 127.0.0.1 --logpath "D:\MongoDB\survey-data\mongod.log" --logappend
