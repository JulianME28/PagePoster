const test=require('node:test'),assert=require('node:assert/strict');
test('WordPress Vietnamese access denial is recognized with Unicode/whitespace variants',async()=>{
 const {isWordPressPermissionDenial:denied}=await import('../server/lifecycle/wordpress-permission.mjs');
 for(const text of ['Xin lỗi, bạn không được phép truy cập vào trang này.','Xin lỗi,\n bạn không được phép truy cập vào trang này.','XIN LOI, BAN KHONG DUOC PHEP TRUY CAP VAO TRANG NAY.', 'Xin lỗi, bạn không được phép truy cập vào trang này.'.normalize('NFD'),'Sorry, you are not allowed to access this page.'])assert.equal(denied(text),true,text);
 for(const text of ['The link you followed has expired.','There has been a critical error on this website.','Đã có lỗi nghiêm trọng trên trang web của bạn.','Xin lỗi, không tìm thấy trang này.',null])assert.equal(denied(text),false);
});
