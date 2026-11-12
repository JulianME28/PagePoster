<?php
namespace PagePoster\Bridge;

// Only the explicit PagePoster operation uses the native Classic Editor adapter.
// Ordinary WordPress saves and all REST authentication remain unchanged.
final class NativeEditor {
    private $factory;
    private Rest $rest;
    public function __construct(callable $factory,Rest $rest) {$this->factory=$factory;$this->rest=$rest;}
    private function scoped(): bool {
        global $pagenow;
        if (!in_array($pagenow,['post-new.php','post.php'],true)) return false;
        if (!in_array($_POST['post_type']??$_GET['post_type']??'post',['page','post'],true)) return false;
        $id=$_GET['pageposter_operation']??$_POST['pageposter_operation']??null;
        try {Contract::operationId($id);return true;} catch (Fault $ignored) {return false;}
    }
    public function blockEditor($enabled,$post) {
        return $this->scoped() && in_array($post->post_type??'', ['page','post'],true) ? false : $enabled;
    }
    public function editorMode($mode) {return $this->scoped() ? 'html' : $mode;}
    public function fields($post): void {
        if (!$this->scoped() || !in_array($post->post_type??'', ['page','post'],true)) return;
        $id=Contract::operationId($_GET['pageposter_operation']??$_POST['pageposter_operation']);
        echo '<input type="hidden" name="pageposter_operation" value="'.esc_attr($id).'">';
        wp_nonce_field('pageposter-native-'.$id,'pageposter_nonce',false);
        echo '<style>#content{display:block!important;visibility:visible!important}#wp-content-editor-tools .wp-editor-tabs,.mce-tinymce{display:none!important}</style>';
    }
    public function submit(): void {
        global $pagenow;
        // Invalid scoped submissions must also stop core handling: never accidentally publish twice.
        if ($pagenow!=='post.php' || ($_SERVER['REQUEST_METHOD']??'')!=='POST' || !array_key_exists('pageposter_operation',$_POST)) return;
        $db=null;
        try {
            $id=Contract::operationId($_POST['pageposter_operation']);
            if (!get_current_user_id() || !is_user_logged_in() || !is_ssl() || is_multisite() || !current_user_can('read') || !current_user_can('unfiltered_html')) throw new Fault('pp_bridge_forbidden','An authorized HTTPS WordPress session is required.',403);
            $nonce=$_POST['pageposter_nonce']??null;
            if (!is_string($nonce) || !wp_verify_nonce($nonce,'pageposter-native-'.$id)) throw new Fault('pp_bridge_nonce','The editor session has expired.',403);
            if (($_POST['action']??'')!=='editpost' || !isset($_POST['publish']) || !is_string($_POST['publish'])) throw new Fault('pp_bridge_validation','Use the native Publish button.',400);
            foreach (['post_type','post_title','content'] as $field) if (!isset($_POST[$field]) || !is_string($_POST[$field])) throw new Fault('pp_bridge_validation','The editor submission is incomplete.',400);
            // WordPress magic quotes must be removed exactly once, preserving all original bytes.
            $input=['operationId'=>$id,'kind'=>'create','postType'=>wp_unslash($_POST['post_type']),'title'=>wp_unslash($_POST['post_title']),'content'=>wp_unslash($_POST['content']),'status'=>'publish'];
            Contract::validate($input);
            $db=($this->factory)();[$status,$data]=$this->rest->executeInput($db,$input);
        } catch (Fault $error) {$status=$error->httpStatus;$data=['code'=>$error->slug,'message'=>$error->getMessage(),'data'=>['status'=>$status]];}
        catch (\Throwable $error) {$status=503;$data=['code'=>'pp_bridge_unavailable','message'=>'Bridge storage is unavailable.','data'=>['status'=>503]];}
        finally {if ($db) {try {$db->close();} catch (\Throwable $ignored) {}}}
        status_header($status);nocache_headers();header('Content-Type: text/html; charset=UTF-8');
        $json=wp_json_encode(['status'=>$status,'data'=>$data],JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT|JSON_UNESCAPED_UNICODE);
        echo '<!doctype html><html><head><meta charset="UTF-8"><title>PagePoster publication</title></head><body><h1>'.($status<300?'PagePoster publication completed':'PagePoster publication requires attention').'</h1><script type="application/json" id="pageposter-operation-result">'.$json.'</script></body></html>';
        exit;
    }
}
